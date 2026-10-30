import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db/connection.ts";
import { newId } from "../domain/ids.ts";
import { findAsset, insertAsset } from "../repos/assets.ts";
import { findGenerationByOutputAsset } from "../repos/generations.ts";
import { prepareDirUnder } from "../util/paths.ts";
import { UnprocessableError } from "../repos/errors.ts";
import { promotionComposeArgs } from "./promotionCompose.ts";
import { preparePromotionInputs } from "./promotionInputs.ts";
import { verifiedPromotionAsset } from "./promotionAsset.ts";
import { fitPromotionText, measurePromotionText, MIN_PROMOTION_FONT_PX, stagePromotionLines, wrapPromotionText } from "./promotionTextFit.ts";
import { requireFontCoverage } from "./fontCoverage.ts";

const exec = promisify(execFile);

/** Produces a reviewable preview with raster-measured title bounds. */
export async function createPromotionPreview(db: DatabaseSync, input: { project_id: string; revision_id: string; source_asset_id: string; assets_root: string; max_bytes: number; ffmpeg: string; ffprobe: string; font: string; font_id?: string; export?: boolean }) {
  const approved = preparePromotionInputs(db, { project_id: input.project_id, revision_id: input.revision_id, assets_root: input.assets_root, max_logo_bytes: input.max_bytes });
  const source = findAsset(db, input.source_asset_id);
  const sourceGeneration = findGenerationByOutputAsset(db, input.project_id, input.source_asset_id);
  const sourceBytes = verifiedPromotionAsset(source, input.project_id, input.assets_root, input.max_bytes, "video/mp4");
  if (!input.font) throw new UnprocessableError("PROMOTION_FONT_FILE must name an installed font file");
  if (!approved.record.title.trim() || approved.record.title.length > 200 || approved.record.title.includes("\0")) throw new UnprocessableError("Promotion title must contain 1–200 characters without NUL");
  const normalizedTitle = approved.record.title.replace(/\r\n?/g, "\n");
  const parent = prepareDirUnder(input.assets_root, input.project_id);
  const scratch = mkdtempSync(join(parent, ".promotion-"));
  const id = newId();
  const finalPath = join(parent, `${id}.mp4`);
  try {
    writeFileSync(join(scratch, "source.mp4"), sourceBytes, { flag: "wx" });
    writeFileSync(join(scratch, "logo.png"), approved.logoBytes, { flag: "wx" });
    writeFileSync(join(scratch, "title.txt"), normalizedTitle, { flag: "wx" });
    copyFileSync(input.font, join(scratch, "font.ttc"));
    const fontBytes = readFileSync(join(scratch, "font.ttc"));
    requireFontCoverage(fontBytes, normalizedTitle);
    const fontSha256 = createHash("sha256").update(fontBytes).digest("hex");
    const probe = async (file: string) => {
      const { stdout } = await exec(input.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { cwd: scratch, timeout: 30000, maxBuffer: 65536, windowsHide: true });
      const data = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
      const video = data.streams?.find((stream) => stream.width && stream.height);
      const duration = Number(data.format?.duration);
      if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new UnprocessableError("Unable to determine video dimensions or duration, or video exceeds one hour");
      return { width: video.width, height: video.height, duration };
    };
    const before = await probe("source.mp4");
    const titleBox = approved.layout.title;
    const box = { width: before.width * titleBox.width, height: before.height * titleBox.height };
    const titlePath = join(scratch, "title.txt");
    const measure = (size: number) => measurePromotionText(input.ffmpeg, scratch, size);
    let fontSize: number | undefined;
    let originalFitError: unknown;
    try { fontSize = await fitPromotionText(box, box.height, measure); }
    catch (error) { if (!(error instanceof UnprocessableError) || !error.message.includes("minimum font size")) throw error; originalFitError = error; }
    let renderedTitle = normalizedTitle;
    // Prefer a two-line-size layout when wrapping improves readability, while
    // retaining a previously fitting original if wrapping is not feasible.
    const targetSize = Math.max(MIN_PROMOTION_FONT_PX, Math.floor(Math.min(256, box.height) / 2));
    if (fontSize === undefined || fontSize < targetSize) {
      try {
        const wrapped = await wrapPromotionText(normalizedTitle, box.width, async (line) => {
          if (!line.trim()) return 0;
          writeFileSync(titlePath, line);
          const bounds = await measure(fontSize === undefined ? MIN_PROMOTION_FONT_PX : targetSize);
          return bounds.clipped ? Number.POSITIVE_INFINITY : bounds.width;
        });
        writeFileSync(titlePath, wrapped);
        const wrappedSize = await fitPromotionText(box, box.height, measure);
        if (fontSize === undefined || wrappedSize > fontSize) { renderedTitle = wrapped; fontSize = wrappedSize; }
      } catch (error) {
        if (!(error instanceof UnprocessableError) || !/Title (cannot wrap|requires too many lines|does not fit)/.test(error.message)) throw error;
        if (fontSize === undefined) throw originalFitError ?? error;
      }
    }
    if (fontSize === undefined) throw originalFitError;
    writeFileSync(titlePath, renderedTitle);
    const lineCount = stagePromotionLines(scratch, renderedTitle);
    const args = promotionComposeArgs(approved.layout, fontSize, before, lineCount);
    // The still logo loops indefinitely; cap both output duration and bytes.
    args.splice(args.length - 1, 0, "-t", String(before.duration), "-fs", String(input.max_bytes));
    await exec(input.ffmpeg, args, { cwd: scratch, timeout: 1800000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (statSync(join(scratch, "output.mp4")).size >= input.max_bytes) throw new UnprocessableError("Promotion output reached the configured size limit");
    const after = await probe("output.mp4");
    if (after.width !== before.width || after.height !== before.height || Math.abs(after.duration - before.duration) > 0.1) throw new UnprocessableError("Preview dimensions or duration differ from the source");
    // Reject if the adopted revision or logo changed while rendering.
    preparePromotionInputs(db, { project_id: input.project_id, revision_id: input.revision_id, assets_root: input.assets_root, max_logo_bytes: input.max_bytes });
    const output = readFileSync(join(scratch, "output.mp4"));
    writeFileSync(finalPath, output, { flag: "wx" });
    return transact(db, () => insertAsset(db, { id, owner_kind: "project", owner_id: input.project_id, kind: input.export ? "promotion-export" : "promotion-preview", path: finalPath, mime: "video/mp4", sha256: createHash("sha256").update(output).digest("hex"), meta: JSON.stringify({ revision_id: input.revision_id, source_asset_id: input.source_asset_id, source_sha256: source?.sha256, source_generation_id: sourceGeneration?.id ?? null, source_blueprint_version_id: sourceGeneration?.blueprint_version_id ?? null, source_document_revision_id: sourceGeneration?.document_revision_id ?? null, logo_asset_id: approved.record.logo_asset_id, logo_sha256: approved.record.logo_sha256, layout: approved.layout, title: approved.record.title, rendered_title: renderedTitle, font_id: input.font_id ?? "configured", font_sha256: fontSha256, font_size_px: fontSize, before, after, preview: !input.export }) }));
  } catch (error) {
    rmSync(finalPath, { force: true });
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
