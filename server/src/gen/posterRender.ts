import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db/connection.ts";
import { newId } from "../domain/ids.ts";
import { insertAsset } from "../repos/assets.ts";
import { UnprocessableError } from "../repos/errors.ts";
import { prepareDirUnder } from "../util/paths.ts";
import { posterComposeArgs } from "./posterCompose.ts";
import { preparePosterInputs } from "./posterInputs.ts";

const exec = promisify(execFile);

/** Render verified approved inputs in private bounded scratch, then register the output. */
export async function renderPoster(db: DatabaseSync, input: { projectId: string; revisionId: string; root: string; maxBytes: number; ffmpeg: string; ffprobe: string; exportFile: boolean }) {
  const approved = preparePosterInputs(db, input);
  const parent = prepareDirUnder(input.root, input.projectId);
  const scratch = mkdtempSync(join(parent, ".poster-"));
  const id = newId(), finalPath = join(parent, `${id}.mp4`);
  try {
    writeFileSync(join(scratch, "still.png"), approved.stillBytes, { flag: "wx" });
    writeFileSync(join(scratch, "motion.mp4"), approved.motionBytes, { flag: "wx" });
    const probe = async (file: string, format: string) => {
      let stdout: string;
      try { ({ stdout } = await exec(input.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", format, "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { cwd: scratch, timeout: 30000, maxBuffer: 65536, windowsHide: true })); }
      catch { throw new UnprocessableError("Unable to inspect poster media"); }
      const data = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
      const stream = data.streams?.find((entry) => entry.width && entry.height);
      if (!stream?.width || !stream.height) throw new UnprocessableError("Poster media has no video dimensions");
      return { width: stream.width, height: stream.height, duration: Number(data.format?.duration) };
    };
    const still = await probe("still.png", "image2"), motion = await probe("motion.mp4", "mov");
    if ([still, motion].some((entry) => entry.width !== approved.layout.width || entry.height !== approved.layout.height)) throw new UnprocessableError("Poster sources must match the approved canvas dimensions");
    const longest = Math.max(...approved.layout.layers.filter((layer) => layer.kind === "motion").map((layer) => layer.loop_frames!)) / approved.layout.fps;
    if (!Number.isFinite(motion.duration) || motion.duration < longest) throw new UnprocessableError("Motion source is shorter than the approved loop");
    const args = posterComposeArgs(approved.layout);
    args.splice(args.length - 1, 0, "-fs", String(input.maxBytes));
    try { await exec(input.ffmpeg, args, { cwd: scratch, timeout: 1800000, maxBuffer: 1024 * 1024, windowsHide: true }); }
    catch { throw new UnprocessableError("Poster rendering failed"); }
    const outputPath = join(scratch, "output.mp4");
    if (statSync(outputPath).size >= input.maxBytes) throw new UnprocessableError("Poster output reached the configured size limit");
    const after = await probe("output.mp4", "mov");
    if (after.width !== approved.layout.width || after.height !== approved.layout.height || !Number.isFinite(after.duration) || Math.abs(after.duration - approved.layout.duration) > 1 / approved.layout.fps + 0.01) throw new UnprocessableError("Poster output dimensions or duration differ from the approved plan");
    preparePosterInputs(db, input);
    const output = readFileSync(outputPath);
    const sha256 = createHash("sha256").update(output).digest("hex");
    renameSync(outputPath, finalPath);
    return transact(db, () => insertAsset(db, { id, owner_kind: "project", owner_id: input.projectId, kind: input.exportFile ? "poster-export" : "poster-preview", path: finalPath, mime: "video/mp4", sha256, meta: JSON.stringify({ revision_id: input.revisionId, blueprint_version_id: approved.blueprint.id, still_asset_id: approved.plan.still_asset_id, still_sha256: approved.plan.still_sha256, motion_asset_id: approved.plan.motion_asset_id, motion_sha256: approved.plan.motion_sha256, layout: approved.layout, after, preview: !input.exportFile }) }));
  } catch (error) { rmSync(finalPath, { force: true }); throw error; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
