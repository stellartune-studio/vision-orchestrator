import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { transact } from "../db/connection.ts";
import { insertAsset, findAsset } from "../repos/assets.ts";
import { BadRequestError, UnprocessableError } from "../repos/errors.ts";
import { isUnder, prepareDirUnder } from "../util/paths.ts";
import type { Asset } from "@vo/shared";

const MAX_EDIT_SECONDS = 60 * 60;
const MAX_SRT_BYTES = 128 * 1024;
const MAX_SRT_CUES = 500;
const TIME = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/;

export interface VideoEditRequest {
  source_asset_id: string;
  start_seconds: number;
  end_seconds: number;
  subtitles_srt?: string;
}

export interface VideoEditOptions {
  ffmpeg_bin: string;
  ffprobe_bin: string;
  assets_root: string;
  /** Test seams; production uses the configured FFmpeg executables. */
  run_ffmpeg?: (binary: string, args: string[], cwd: string) => Promise<void>;
  probe_duration?: (binary: string, file: string) => Promise<number>;
}

export interface VideoEditResult {
  asset: Asset;
  source_asset_id: string;
  start_seconds: number;
  end_seconds: number;
  subtitle_sha256: string | null;
}

function parseSrtTimestamp(value: string): number {
  const match = TIME.exec(value);
  if (!match) throw new BadRequestError(`invalid SRT timestamp: ${value}`);
  const [, hh, mm, ss, ms] = match;
  const minutes = Number(mm);
  const seconds = Number(ss);
  if (minutes > 59 || seconds > 59) {
    throw new BadRequestError(`invalid SRT timestamp: ${value}`);
  }
  return Number(hh) * 3600 + minutes * 60 + seconds + Number(ms) / 1000;
}

export function validateVideoEditRequest(value: unknown): VideoEditRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("video edit body must be an object");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "source_asset_id",
    "start_seconds",
    "end_seconds",
    "subtitles_srt",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new BadRequestError("video edit request contains unsupported fields");
  }
  if (typeof body.source_asset_id !== "string" || !body.source_asset_id.trim()) {
    throw new BadRequestError("source_asset_id is required");
  }
  const { start_seconds, end_seconds } = body;
  if (typeof start_seconds !== "number" || !Number.isFinite(start_seconds) || start_seconds < 0) {
    throw new BadRequestError("start_seconds must be a non-negative number");
  }
  if (typeof end_seconds !== "number" || !Number.isFinite(end_seconds) || end_seconds <= start_seconds) {
    throw new BadRequestError("end_seconds must be greater than start_seconds");
  }
  if (end_seconds - start_seconds > MAX_EDIT_SECONDS) {
    throw new BadRequestError("video edit range cannot exceed one hour");
  }
  if (body.subtitles_srt !== undefined && typeof body.subtitles_srt !== "string") {
    throw new BadRequestError("subtitles_srt must be a string");
  }
  const subtitles = body.subtitles_srt as string | undefined;
  if (subtitles !== undefined) validateSrt(subtitles, end_seconds - start_seconds);
  return {
    source_asset_id: body.source_asset_id.trim(),
    start_seconds,
    end_seconds,
    subtitles_srt: subtitles,
  };
}

function validateSrt(srt: string, duration: number): void {
  if (Buffer.byteLength(srt, "utf8") > MAX_SRT_BYTES) {
    throw new BadRequestError("subtitles_srt exceeds 128 KiB");
  }
  if (srt.includes("\0")) throw new BadRequestError("subtitles_srt contains a NUL byte");
  if (/\{\\[^}]*\}/.test(srt)) throw new BadRequestError("subtitle text cannot contain ASS override tags");
  const blocks = srt.trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  if (blocks.length > MAX_SRT_CUES) throw new BadRequestError("subtitles_srt exceeds 500 cues");
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 3 || !/^\d+$/.test(lines[0].trim())) {
      throw new BadRequestError("subtitles_srt must contain numbered SRT cues");
    }
    const timing = /^(\d{2,}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2},\d{3})$/.exec(lines[1].trim());
    if (!timing) throw new BadRequestError("subtitles_srt contains an invalid cue time range");
    const start = parseSrtTimestamp(timing[1]);
    const end = parseSrtTimestamp(timing[2]);
    if (end <= start || end > duration) {
      throw new BadRequestError("subtitle cue times must be increasing and within the edited clip");
    }
    if (lines.slice(2).join("\n").trim() === "") {
      throw new BadRequestError("subtitle cue text cannot be empty");
    }
  }
}

export function buildVideoEditArgs(
  input: VideoEditRequest,
  sourcePath: string,
  outputName: string,
  subtitleName?: string,
): string[] {
  const args = [
    "-hide_banner", "-nostdin",
    "-ss", String(input.start_seconds),
    "-i", sourcePath,
    "-t", String(input.end_seconds - input.start_seconds),
    "-map", "0:v:0", "-map", "0:a?",
  ];
  if (subtitleName) args.push("-vf", `subtitles=filename='${subtitleName}'`);
  args.push(
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-movflags", "+faststart", outputName,
  );
  return args;
}

function capture(binary: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString("utf8").slice(0, 4096 - stdout.length); });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length); });
    child.once("error", (error) => finish(new UnprocessableError(`Media tool could not start: ${error.message}`)));
    child.once("close", (code) => {
      if (timedOut) finish(new UnprocessableError("Media probe timed out after 30 seconds"));
      else if (code === 0) finish(undefined, stdout.trim());
      else finish(new UnprocessableError(`Media probe failed (${code}): ${stderr.trim().slice(-1000) || "no diagnostic output"}`));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    timer.unref();
  });
}

async function probeDuration(binary: string, file: string): Promise<number> {
  const text = await capture(binary, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const duration = Number(text);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new UnprocessableError("Media probe did not return a valid duration");
  }
  return duration;
}

function runFfmpeg(binary: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
    });
    child.once("error", (error) => finish(new UnprocessableError(`FFmpeg could not start: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (timedOut) finish(new UnprocessableError("FFmpeg timed out after 30 minutes"));
      else if (code === 0) finish();
      else finish(new UnprocessableError(`FFmpeg failed (${signal ?? code}): ${stderr.trim().slice(-2000) || "no diagnostic output"}`));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30 * 60 * 1000);
    timer.unref();
  });
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function createEditedVideo(
  db: DatabaseSync,
  projectId: string,
  rawInput: unknown,
  options: VideoEditOptions,
): Promise<VideoEditResult> {
  const input = validateVideoEditRequest(rawInput);
  const source = findAsset(db, input.source_asset_id);
  if (!source || source.owner_kind !== "project" || source.owner_id !== projectId) {
    throw new UnprocessableError("source video must belong to this project");
  }
  if (source.mime !== "video/mp4") {
    throw new UnprocessableError("only project-owned MP4 video assets can be edited");
  }
  let sourcePath: string;
  try {
    sourcePath = realpathSync(source.path);
    if (!isUnder(realpathSync(options.assets_root), sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error("outside asset storage");
    }
  } catch {
    throw new UnprocessableError("source video is missing or outside project asset storage");
  }
  const sourceHash = await hashFile(sourcePath);
  if (source.sha256 && source.sha256.toLowerCase() !== sourceHash) {
    throw new UnprocessableError("source video content differs from registered hash");
  }
  const sourceDuration = await (options.probe_duration ?? probeDuration)(options.ffprobe_bin, sourcePath);
  if (input.end_seconds > sourceDuration + 0.05) {
    throw new BadRequestError(`end_seconds exceeds source duration (${sourceDuration.toFixed(3)} seconds)`);
  }
  const assetId = newId();
  const dir = prepareDirUnder(options.assets_root, projectId);
  const outputPath = join(dir, `${assetId}.mp4`);
  const stagingDir = mkdtempSync(join(dir, ".video-edit-"));
  const stagedOutputPath = join(stagingDir, `${assetId}.mp4`);
  let outputCreated = false;
  const outputName = `${assetId}.mp4`;
  const subtitleName = input.subtitles_srt ? `${assetId}.srt` : undefined;
  const subtitlePath = subtitleName ? join(stagingDir, subtitleName) : undefined;
  try {
    if (subtitlePath) writeFileSync(subtitlePath, input.subtitles_srt!, { flag: "wx" });
    await (options.run_ffmpeg ?? runFfmpeg)(
      options.ffmpeg_bin,
      buildVideoEditArgs(input, sourcePath, outputName, subtitleName),
      stagingDir,
    );
    if (!existsSync(stagedOutputPath) || !statSync(stagedOutputPath).isFile() || statSync(stagedOutputPath).size === 0) {
      throw new UnprocessableError("FFmpeg reported success but produced no video file");
    }
    const outputDuration = await (options.probe_duration ?? probeDuration)(options.ffprobe_bin, stagedOutputPath);
    const expectedDuration = input.end_seconds - input.start_seconds;
    if (Math.abs(outputDuration - expectedDuration) > 0.5) {
      throw new UnprocessableError(`Edited duration ${outputDuration.toFixed(3)}s differs from requested ${expectedDuration.toFixed(3)}s`);
    }
    if (await hashFile(sourcePath) !== sourceHash) {
      throw new UnprocessableError("source video changed during edit");
    }
    const sha256 = await hashFile(stagedOutputPath);
    copyFileSync(stagedOutputPath, outputPath, constants.COPYFILE_EXCL);
    outputCreated = true;
    const subtitleSha = input.subtitles_srt
      ? createHash("sha256").update(input.subtitles_srt).digest("hex")
      : null;
    const asset = transact(db, () => insertAsset(db, {
      id: assetId,
      owner_kind: "project",
      owner_id: projectId,
      kind: "edited-video",
      path: outputPath,
      mime: "video/mp4",
      sha256,
      meta: JSON.stringify({
        edit: "trim-and-caption-v1",
        source_asset_id: source.id,
        source_sha256: sourceHash,
        start_seconds: input.start_seconds,
        end_seconds: input.end_seconds,
        subtitles_sha256: subtitleSha,
        subtitles_srt: input.subtitles_srt ?? null,
      }),
    }));
    return {
      asset,
      source_asset_id: source.id,
      start_seconds: input.start_seconds,
      end_seconds: input.end_seconds,
      subtitle_sha256: subtitleSha,
    };
  } catch (error) {
    if (outputCreated) {
      try { unlinkSync(outputPath); } catch { /* absent or already removed */ }
    }
    throw error;
  } finally {
    if (subtitlePath) {
      try { unlinkSync(subtitlePath); } catch { /* absent or already removed */ }
    }
    try { unlinkSync(stagedOutputPath); } catch { /* absent or already removed */ }
    try { rmdirSync(stagingDir); } catch { /* retain unexpected contents */ }
  }
}
