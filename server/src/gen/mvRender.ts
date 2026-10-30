import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db/connection.ts";
import { newId } from "../domain/ids.ts";
import { findAsset, insertAsset } from "../repos/assets.ts";
import { approvedMvPlan } from "../repos/mvPlans.ts";
import { findDocumentRevision } from "../repos/documents.ts";
import { getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { findGenerationByOutputAsset } from "../repos/generations.ts";
import { UnprocessableError } from "../repos/errors.ts";
import { prepareDirUnder } from "../util/paths.ts";
import { verifiedPromotionAsset } from "./promotionAsset.ts";
import { probeMvAudioDuration } from "./mvAudio.ts";
import { fitPromotionText, measurePromotionText } from "./promotionTextFit.ts";
import { boundedMediaOutput } from "./boundedMediaOutput.ts";

const exec = promisify(execFile);
type Lyric = { start: number; end: number; text: string };

/** Render adopted cuts at their manually chosen beat positions; no beat detection is implied. */
export async function renderMv(db: DatabaseSync, input: { project_id: string; revision_id: string; video_id: string; root: string; max_bytes: number; ffmpeg: string; ffprobe: string; font: string; export_file: boolean }) {
  const plan = approvedMvPlan(db, input.project_id, input.revision_id);
  const revision = findDocumentRevision(db, input.revision_id);
  if (!revision?.blueprint_version_id) throw new UnprocessableError("Approved MV plan has no frozen blueprint");
  const blueprint = getBlueprintVersionDetail(db, revision.blueprint_version_id);
  if (blueprint.project_id !== input.project_id) throw new UnprocessableError("Blueprint belongs to another project");
  const cuts = JSON.parse(plan.clips_json) as { video_asset_id: string; start: number; sha256: string }[];
  const selected = cuts.length ? cuts : [{ video_asset_id: input.video_id, start: 0, sha256: "" }];
  const beats = JSON.parse(plan.beats_json) as number[];
  if (!Array.isArray(selected) || selected.length > 64 || selected.some((cut, i) => !cut || typeof cut.video_asset_id !== "string" || typeof cut.start !== "number" || !Number.isFinite(cut.start) || (i === 0 ? cut.start !== 0 : cut.start <= selected[i - 1].start || !beats.includes(cut.start)) || cut.start >= plan.audio_duration)) throw new UnprocessableError("Invalid approved cut positions");
  const audio = findAsset(db, plan.audio_asset_id);
  if (!audio?.mime?.startsWith("audio/") || audio.sha256?.toLowerCase() !== plan.audio_sha256.toLowerCase()) throw new UnprocessableError("The approved audio asset changed");
  const audioBytes = verifiedPromotionAsset(audio, input.project_id, input.root, input.max_bytes, audio.mime);
  const sourceCache = new Map<string, { video: NonNullable<ReturnType<typeof findAsset>>; bytes: Buffer; generation: ReturnType<typeof findGenerationByOutputAsset> }>();
  let totalSourceBytes = 0;
  const sources = selected.map((cut) => {
    if (!blueprint.assets.some((asset) => asset.asset_id === cut.video_asset_id)) throw new UnprocessableError("Source video must be selected in the MV plan's frozen blueprint");
    const cached = sourceCache.get(cut.video_asset_id);
    if (cached) {
      if (cut.sha256 && cached.video.sha256?.toLowerCase() !== cut.sha256.toLowerCase()) throw new UnprocessableError("An approved cut video changed");
      return { cut, ...cached };
    }
    const video = findAsset(db, cut.video_asset_id);
    if (cut.sha256 && video?.sha256?.toLowerCase() !== cut.sha256.toLowerCase()) throw new UnprocessableError("An approved cut video changed");
    const bytes = verifiedPromotionAsset(video, input.project_id, input.root, input.max_bytes, "video/mp4");
    totalSourceBytes += bytes.length;
    if (totalSourceBytes > input.max_bytes) throw new UnprocessableError("The combined source videos exceed the configured asset size limit");
    const generation = findGenerationByOutputAsset(db, input.project_id, cut.video_asset_id);
    const source = { video: video!, bytes, generation };
    sourceCache.set(cut.video_asset_id, source);
    return { cut, ...source };
  });
  const duration = await probeMvAudioDuration(audioBytes, input.root, input.ffprobe);
  if (Math.abs(duration - plan.audio_duration) > 0.001) throw new UnprocessableError("Audio duration differs from the approved plan");
  const lyrics = JSON.parse(plan.lyrics_json) as Lyric[];
  if (!Array.isArray(lyrics) || lyrics.length > 200) throw new UnprocessableError("Invalid approved lyrics");
  if (lyrics.length && !input.font) throw new UnprocessableError("PROMOTION_FONT_FILE must name an installed font file");
  let end = 0;
  for (const line of lyrics) {
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < end || line.end <= line.start || line.end > duration || typeof line.text !== "string" || !line.text.trim() || line.text.length > 1000 || /[\x00-\x1f]/.test(line.text)) throw new UnprocessableError("Invalid lyric text or timing in the approved plan");
    end = line.end;
  }
  const parent = prepareDirUnder(input.root, input.project_id);
  const scratch = mkdtempSync(join(parent, ".mv-render-"));
  const id = newId(), finalPath = join(parent, `${id}.mp4`);
  try {
    // A clip used more than once has one temporary copy, while every FFmpeg input
    // still reads the verified bytes staged under this private directory.
    const sourceFiles = new Map<string, string>();
    for (const source of sources) {
      if (!sourceFiles.has(source.video.id)) {
        const file = `source${sourceFiles.size}.mp4`;
        writeFileSync(join(scratch, file), source.bytes, { flag: "wx" });
        sourceFiles.set(source.video.id, file);
      }
    }
    writeFileSync(join(scratch, "audio"), audioBytes, { flag: "wx" });
    let fontHash: string | null = null;
    if (lyrics.length) {
      copyFileSync(input.font, join(scratch, "font.ttc"));
      fontHash = createHash("sha256").update(readFileSync(join(scratch, "font.ttc"))).digest("hex");
    }
    const probe = async (file: string) => {
      let stdout: string;
      try { ({ stdout } = await exec(input.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { cwd: scratch, timeout: 30000, maxBuffer: 65536, windowsHide: true })); }
      catch { throw new UnprocessableError("Cannot read source or output video"); }
      const result = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
      const videoStream = result.streams?.find((entry) => entry.width && entry.height), seconds = Number(result.format?.duration);
      if (!videoStream?.width || !videoStream.height || !Number.isFinite(seconds) || seconds <= 0) throw new UnprocessableError("Cannot determine video dimensions or duration");
      return { width: videoStream.width, height: videoStream.height, duration: seconds };
    };
    const before: { width: number; height: number; duration: number }[] = [];
    for (let i = 0; i < sources.length; i++) before.push(await probe(sourceFiles.get(sources[i].video.id)!));
    const lengths = selected.map((cut, i) => (selected[i + 1]?.start ?? duration) - cut.start);
    if (before.some((item, i) => item.duration + 0.001 < lengths[i])) throw new UnprocessableError("A source clip is shorter than its assigned interval");
    if (before.some((item) => item.width !== before[0].width || item.height !== before[0].height)) throw new UnprocessableError("All cut videos must have the same dimensions");
    const filters: string[] = [];
    const fontSizes: number[] = [];
    for (let i = 0; i < lyrics.length; i++) {
      const line = lyrics[i];
      writeFileSync(join(scratch, "title.txt"), line.text, "utf8");
      writeFileSync(join(scratch, `line${i}.txt`), line.text, { flag: "wx" });
      const fontSize = await fitPromotionText({ width: before[0].width * 0.8, height: before[0].height * 0.08 }, before[0].height * 0.08, (size) => measurePromotionText(input.ffmpeg, scratch, size));
      fontSizes.push(fontSize);
      // Indices and validated numeric timestamps are the only interpolated data.
      filters.push(`drawtext=fontfile=font.ttc:ft_load_flags=no_bitmap:textfile=line${i}.txt:expansion=none:fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=h*0.85:enable='gte(t,${line.start})*lt(t,${line.end})'`);
    }
    const inputs = sources.flatMap((_, i) => ["-protocol_whitelist", "file,pipe", "-f", "mov", "-i", sourceFiles.get(sources[i].video.id)!]);
    const segments = sources.map((_, i) => `[${i}:v:0]trim=duration=${lengths[i]},setpts=PTS-STARTPTS[v${i}]`);
    const concat = `${sources.map((_, i) => `[v${i}]`).join("")}concat=n=${sources.length}:v=1:a=0${filters.length ? `,${filters.join(",")}` : ""}[vout]`;
    const args = ["-hide_banner", "-nostdin", ...inputs, "-protocol_whitelist", "file,pipe", "-i", "audio", "-filter_complex", [...segments, concat].join(";"), "-map", "[vout]", "-map", `${sources.length}:a:0`, "-t", String(duration), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-bf", "0", "-c:a", "aac", "-avoid_negative_ts", "disabled", "-movflags", "+frag_keyframe+delay_moov", "-f", "mp4", "pipe:1"];
    const media = await boundedMediaOutput(input.ffmpeg, args, scratch, input.max_bytes);
    writeFileSync(join(scratch, "output.mp4"), media, { flag: "wx" });
    const after = await probe("output.mp4");
    if (after.width !== before[0].width || after.height !== before[0].height || Math.abs(after.duration - duration) > 0.1) throw new UnprocessableError("MV output dimensions or duration differ from the approved inputs");
    const current = approvedMvPlan(db, input.project_id, input.revision_id);
    if (current.audio_sha256 !== plan.audio_sha256) throw new UnprocessableError("Approved MV plan changed during rendering");
    const currentAudio = findAsset(db, plan.audio_asset_id);
    if (currentAudio?.sha256?.toLowerCase() !== plan.audio_sha256.toLowerCase()) throw new UnprocessableError("MV audio changed during rendering");
    verifiedPromotionAsset(currentAudio, input.project_id, input.root, input.max_bytes, audio.mime);
    for (const source of sources) {
      const currentVideo = findAsset(db, source.video.id);
      if (currentVideo?.sha256?.toLowerCase() !== source.video.sha256?.toLowerCase()) throw new UnprocessableError("MV video changed during rendering");
      verifiedPromotionAsset(currentVideo, input.project_id, input.root, input.max_bytes, "video/mp4");
    }
    const output = readFileSync(join(scratch, "output.mp4"));
    renameSync(join(scratch, "output.mp4"), finalPath);
    return transact(db, () => insertAsset(db, { id, owner_kind: "project", owner_id: input.project_id, kind: input.export_file ? "mv-export" : "mv-preview", path: finalPath, mime: "video/mp4", sha256: createHash("sha256").update(output).digest("hex"), meta: JSON.stringify({ revision_id: input.revision_id, blueprint_version_id: blueprint.id, audio_asset_id: audio.id, audio_sha256: plan.audio_sha256, clips: sources.map((source) => ({ ...source.cut, sha256: source.video.sha256, source_generation_id: source.generation?.id ?? null, source_blueprint_version_id: source.generation?.blueprint_version_id ?? null })), manual_beats: JSON.parse(plan.beats_json), beat_origin: plan.beat_origin, lyrics, font_sha256: fontHash, font_sizes: fontSizes, before, after, preview: !input.export_file }) }));
  } catch (error) { rmSync(finalPath, { force: true }); throw error; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
