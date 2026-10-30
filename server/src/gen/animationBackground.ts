import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db/connection.ts";
import { newId } from "../domain/ids.ts";
import { findAsset, insertAsset } from "../repos/assets.ts";
import { getItem } from "../repos/items.ts";
import { blueprintDriftNotes, getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { animationBackgroundPlan } from "../repos/animationBackgrounds.ts";
import { ConflictError, UnprocessableError } from "../repos/errors.ts";
import { prepareDirUnder } from "../util/paths.ts";
import { verifiedPromotionAsset } from "./promotionAsset.ts";
import { runOwnedProcess } from "./ownedProcess.ts";
import type { ChildProcess } from "node:child_process";

const MAX_PIXELS = 4096 * 4096;

export function checkedAnimationImages(db: DatabaseSync, input: { projectId: string; backgroundId: string; foregroundId: string; root: string; maxBytes: number }) {
  if (input.backgroundId === input.foregroundId) throw new UnprocessableError("Background and foreground must be distinct images");
  const background = findAsset(db, input.backgroundId), foreground = findAsset(db, input.foregroundId);
  if (!background?.selected || !foreground?.selected) throw new UnprocessableError("Select both project images before approving composition");
  const bg = verifiedPromotionAsset(background, input.projectId, input.root, input.maxBytes, "image/png");
  const fg = verifiedPromotionAsset(foreground, input.projectId, input.root, input.maxBytes, "image/png");
  if (bg.length + fg.length > input.maxBytes) throw new UnprocessableError("Combined composition inputs exceed the size limit");
  const width = bg.readUInt32BE(16), height = bg.readUInt32BE(20);
  if (width * height > MAX_PIXELS || width !== fg.readUInt32BE(16) || height !== fg.readUInt32BE(20)) throw new UnprocessableError("Composition images must have matching dimensions within the pixel limit");
  if (fg[25] !== 4 && fg[25] !== 6) throw new UnprocessableError("Foreground PNG must have an alpha channel");
  return { background: background!, foreground: foreground!, bg, fg, width, height };
}

export function approvedAnimationInputs(db: DatabaseSync, input: { projectId: string; shotId: string; blueprintId: string; root: string; maxBytes: number }) {
  const blueprint = getBlueprintVersionDetail(db, input.blueprintId);
  const shot = getItem(db, input.shotId);
  const frozen = blueprint.items.find((item) => item.item_id === shot.id && item.kind === "shot");
  if (blueprint.project_id !== input.projectId || shot.project_id !== input.projectId || !frozen || shot.adopted_revision_id !== frozen.revision_id || blueprintDriftNotes(db, blueprint.id).length) throw new ConflictError("Adopt the shot and freeze the current blueprint before composition");
  const plan = animationBackgroundPlan(db, frozen.revision_id);
  if (!plan || ![plan.background_asset_id, plan.foreground_asset_id].every((id) => blueprint.assets.some((asset) => asset.asset_id === id))) throw new ConflictError("Approved background inputs are not frozen in the blueprint");
  const checked = checkedAnimationImages(db, { ...input, backgroundId: plan.background_asset_id, foregroundId: plan.foreground_asset_id });
  if (checked.background.sha256 !== plan.background_sha256 || checked.foreground.sha256 !== plan.foreground_sha256) throw new ConflictError("Approved composition assets changed");
  return { plan, blueprint, checked };
}

export async function renderAnimationBackground(db: DatabaseSync, input: { projectId: string; shotId: string; blueprintId: string; root: string; maxBytes: number; ffmpeg: string; signal: AbortSignal; jobId?: string; runProcess?: typeof runOwnedProcess; onProcessStart?: (child: ChildProcess) => void }) {
  const approved = approvedAnimationInputs(db, input);
  const parent = prepareDirUnder(input.root, input.projectId), scratch = mkdtempSync(join(parent, ".animation-composite-"));
  const id = newId(), finalPath = join(parent, `${id}.png`);
  try {
    writeFileSync(join(scratch, "background.png"), approved.checked.bg, { flag: "wx" });
    writeFileSync(join(scratch, "foreground.png"), approved.checked.fg, { flag: "wx" });
    try {
      await (input.runProcess ?? runOwnedProcess)(input.ffmpeg, ["-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", "background.png", "-protocol_whitelist", "file,pipe", "-i", "foreground.png", "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[out]", "-map", "[out]", "-frames:v", "1", "-threads", "1", "-fs", String(input.maxBytes), "output.png"], { cwd: scratch, timeoutMs: 120000, signal: input.signal, onStart: input.onProcessStart });
    } catch { throw new UnprocessableError(input.signal.aborted ? "Composition cancelled" : "Animation background composition failed"); }
    if (input.signal.aborted) throw new UnprocessableError("Composition cancelled");
    const file = join(scratch, "output.png");
    if (statSync(file).size >= input.maxBytes) throw new UnprocessableError("Composition reached the size limit");
    const output = readFileSync(file);
    if (output.length < 24 || output.readUInt32BE(16) !== approved.checked.width || output.readUInt32BE(20) !== approved.checked.height) throw new UnprocessableError("Composition output dimensions differ from approved inputs");
    approvedAnimationInputs(db, input);
    renameSync(file, finalPath);
    return transact(db, () => insertAsset(db, { id, owner_kind: "project", owner_id: input.projectId, kind: "animation-composite", path: finalPath, mime: "image/png", sha256: createHash("sha256").update(output).digest("hex"), meta: JSON.stringify({ composition_job_id: input.jobId ?? null, blueprint_version_id: approved.blueprint.id, shot_id: input.shotId, shot_revision_id: approved.plan.revision_id, background_asset_id: approved.plan.background_asset_id, background_sha256: approved.plan.background_sha256, foreground_asset_id: approved.plan.foreground_asset_id, foreground_sha256: approved.plan.foreground_sha256, operation: "foreground_over_background", width: approved.checked.width, height: approved.checked.height }) }));
  } catch (error) { rmSync(finalPath, { force: true }); throw error; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
