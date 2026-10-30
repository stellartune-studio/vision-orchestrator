import { randomInt } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CharacterProfile } from "@vo/shared";
import type { GenerationBackend, GenerationInput } from "./backend.ts";
import { getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { sceneCharacters } from "../repos/sceneCharacters.ts";
import { findAsset } from "../repos/assets.ts";
import { findDocumentRevision, getDocument } from "../repos/documents.ts";
import { UnprocessableError } from "../repos/errors.ts";
import { safeBasename } from "../util/paths.ts";

/** Max bytes of a text material inlined into the prompt — over is 422. */
const MAX_MATERIAL_TEXT_BYTES = 8 * 1024;

/**
 * Convert APPROVED blueprint content into a concrete generation
 * payload. This is the boundary where "what the director agreed" meets
 * "what the model receives":
 *
 *   - only adopted revisions feed the prompt — unconfirmed proposals
 *     are structurally absent from a blueprint_version snapshot
 *   - the approved document revision derived from this snapshot is part
 *     of the prompt — its direction must reach the model, not just be
 *     recorded in resolved_refs
 *   - unsupported inputs are REJECTED, never silently dropped (e.g. a
 *     base image on a backend that cannot consume ref images, or a
 *     selected material no backend input can express)
 *   - the resolved_refs snapshot lets a later output trace back to the
 *     exact item/character/asset/document versions used
 */
export function buildGenerationInput(
  db: DatabaseSync,
  args: {
    project_id: string;
    blueprint_version_id: string;
    document_revision_id?: string | null;
    backend: GenerationBackend;
    kind: "image" | "video";
    story_scene_id?: string;
    exclusive_edit_source_id?: string;
    duration_seconds?: number;
    /** Use native H3 dimensions only for the bundled video workflow. */
    native_video_size?: boolean;
    /** true only when the effective workflow is the verified H3/FastH3
     *  prompt path — unknown video workflows must not receive the
     *  camera sentence */
    camera_prompt?: boolean;
  },
): GenerationInput {
  const { backend } = args;
  const bv = getBlueprintVersionDetail(db, args.blueprint_version_id);
  if (bv.project_id !== args.project_id) {
    throw new UnprocessableError(
      "blueprint version belongs to another project",
    );
  }

  const selectedScene = args.story_scene_id ? bv.items.find((item) => item.item_id === args.story_scene_id && item.kind === "story_segment") : undefined;
  if (args.story_scene_id && !selectedScene) throw new UnprocessableError("Scene is not part of the approved blueprint");
  const selectedCast = selectedScene ? sceneCharacters(db, selectedScene.revision_id) : null;
  if (selectedCast?.some((cast) => !bv.characters.some((character) => character.character_id === cast.character_id && character.character_revision_id === cast.character_revision_id))) {
    throw new UnprocessableError("Scene character revisions do not match the frozen blueprint");
  }

  // Prompt order matters for the image model: lead with the approved
  // document (the visual direction), then scene/shot content, then
  // character appearance and hard constraints; project-level context
  // (intent/audience/worldview) trails as guidance, not the subject.
  const promptParts: string[] = [];
  if (selectedScene) promptParts.push(`Generate only the selected scene: ${selectedScene.label}. Other script text is context, not a request to depict all scenes.`);
  const ordered = [...bv.items].sort((a, b) =>
    a.kind === b.kind ? a.seq - b.seq : a.kind < b.kind ? -1 : 1,
  );
  const itemRevIds: string[] = [];
  const contentByItem = new Map<string, string>();
  for (const i of bv.items) {
    if (!selectedScene || (i.kind !== "story_segment" && i.kind !== "shot") || i.item_id === selectedScene.item_id || (i.kind === "shot" && i.parent_item_id === selectedScene.item_id)) itemRevIds.push(i.revision_id);
    const row = db
      .prepare("SELECT content FROM item_revisions WHERE id = ?")
      .get(i.revision_id) as { content: string } | undefined;
    if (row) contentByItem.set(i.item_id, row.content);
  }

  const find = (kind: string) =>
    bv.items.find((i) => i.kind === kind)?.item_id;

  // The APPROVED script/storyboard derived from this snapshot feeds
  // the prompt — a director's edit to that document must change what
  // the model is told, or the approval link is decoration. It leads
  // the prompt so the model reads the visual direction first.
  if (args.document_revision_id) {
    const rev = findDocumentRevision(db, args.document_revision_id);
    const doc = rev ? getDocument(db, rev.document_id) : undefined;
    if (
      !rev ||
      !doc ||
      doc.project_id !== args.project_id ||
      doc.adopted_revision_id !== rev.id ||
      rev.blueprint_version_id !== bv.id
    ) {
      throw new UnprocessableError(
        "document_revision_id must be this project's adopted revision " +
          "derived from this blueprint version",
      );
    }
    promptParts.push(
      `${doc.kind === "script" ? "Script" : "Storyboard"}: ${rev.content}`,
    );
  }

  const segments = ordered.filter((i) => i.kind === "story_segment" && (!selectedScene || i.item_id === selectedScene.item_id));
  for (const s of segments) {
    const c = contentByItem.get(s.item_id);
    const cast = sceneCharacters(db, s.revision_id);
    if (c) promptParts.push(`Scene ${s.seq}: ${c}${cast.length ? `\nCharacters in scene: ${cast.map((character) => character.name).join(", ")}` : ""}`);
  }
  // Shots hang under a story_segment via parent_item_id — their cut
  // descriptions are approved plan content, not optional context.
  for (const s of ordered.filter((i) => i.kind === "shot" && (!selectedScene || i.parent_item_id === selectedScene.item_id))) {
    const c = contentByItem.get(s.item_id);
    if (!c) continue;
    const parent = s.parent_item_id
      ? bv.items.find((i) => i.item_id === s.parent_item_id)
      : undefined;
    promptParts.push(
      `Shot ${s.seq}${parent ? ` (${parent.label})` : ""}: ${c}`,
    );
  }
  // Characters: locked traits become prompt fragments; base images
  // become reference images (capability-gated below, together with
  // selected image materials).
  const charRevIds: string[] = [];
  const baseImageAssetIds: string[] = [];
  for (const c of bv.characters.filter((character) => !selectedCast || selectedCast.some((cast) => cast.character_id === character.character_id && cast.character_revision_id === character.character_revision_id))) {
    charRevIds.push(c.character_revision_id);
    const rev = db
      .prepare("SELECT profile FROM character_revisions WHERE id = ?")
      .get(c.character_revision_id) as { profile: string } | undefined;
    if (rev) {
      try {
        const profile = JSON.parse(rev.profile) as CharacterProfile;
        const charRow = db
          .prepare("SELECT name FROM characters WHERE id = ?")
          .get(c.character_id) as { name: string } | undefined;
        const name = charRow?.name?.trim() || "Character";
        const locked = profile.traits?.locked ?? {};
        const traitText = Object.entries(locked)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        if (traitText) {
          promptParts.push(`${name} — fixed: ${traitText}`);
        }
        if (profile.appearance) {
          promptParts.push(`${name} appearance: ${profile.appearance}`);
        }
      } catch {
        promptParts.push(`Character profile: ${rev.profile}`);
      }
    }
    if (c.base_image_asset_id && (!args.exclusive_edit_source_id || c.base_image_asset_id === args.exclusive_edit_source_id)) {
      baseImageAssetIds.push(c.base_image_asset_id);
    }
  }

  const constraints = ordered.filter((i) => i.kind === "fixed_constraint");
  for (const c of constraints) {
    const t = contentByItem.get(c.item_id);
    if (t) promptParts.push(`Must keep: ${t}`);
  }
  for (const m of ordered.filter((i) => i.kind === "material")) {
    const t = contentByItem.get(m.item_id);
    if (t) promptParts.push(`Materials: ${t}`);
  }

  // camera_work (optional): the adopted text reaches a VIDEO prompt as
  // one explicit sentence. "Camera movement:" is an app-side delimiter,
  // not official model syntax; delivery is prompt-level and the visual
  // effect stays unverified until a real run is inspected. Image kind
  // and prompt-verbatim mode never receive this line; an unspecified or
  // unadopted item changes nothing. Identical lines are added once.
  const cameraWorkRevIds: string[] = [];
  const cameraWorkAppliedRevIds: string[] = [];
  for (const c of ordered.filter((i) => i.kind === "camera_work")) {
    cameraWorkRevIds.push(c.revision_id);
    const t = contentByItem.get(c.item_id);
    if (
      args.kind === "video" &&
      args.camera_prompt === true &&
      t &&
      !promptParts.includes(`Camera movement: ${t}`)
    ) {
      promptParts.push(`Camera movement: ${t}`);
      cameraWorkAppliedRevIds.push(c.revision_id);
    }
  }

  // Project-level context trails the visual content: it steers tone
  // and audience, but it is not the subject of the image itself.
  for (const [label, kind] of [
    ["Intent", "intent"],
    ["Audience", "audience"],
    ["Worldview", "worldview"],
  ] as const) {
    const id = find(kind);
    const c = id ? contentByItem.get(id) : undefined;
    if (c) promptParts.push(`${label}: ${c}`);
  }

  // Selected material assets are production inputs, not decorations:
  // images join the reference-image set; text/json files are inlined
  // into the prompt; anything the backend cannot express is REJECTED
  // so an unusable selection can never be silently ignored.
  const assetIds: string[] = [];
  const usedAssetIds: string[] = [];
  const materialImageAssetIds: string[] = [];
  for (const a of bv.assets) {
    const asset = findAsset(db, a.asset_id);
    if (!asset) {
      throw new UnprocessableError(`asset ${a.asset_id} not found`);
    }
    assetIds.push(a.asset_id);
    const mime = asset.mime ?? "";
    if (mime.startsWith("image/")) {
      if (!args.exclusive_edit_source_id || a.asset_id === args.exclusive_edit_source_id) materialImageAssetIds.push(a.asset_id);
      else continue; // The scene approval explicitly selected another single edit image.
    } else if (mime.startsWith("text/") || mime === "application/json") {
      promptParts.push(
        `Material file (${safeBasename(asset.path)}): ` +
          readMaterialText(asset.id, asset.path),
      );
    } else {
      throw new UnprocessableError(
        `selected material ${a.asset_id} (${mime || "unknown type"}) ` +
          `cannot feed ${args.kind} generation — deselect it or ` +
          `exclude it from the blueprint`,
      );
    }
    usedAssetIds.push(a.asset_id);
  }

  // Reference images = character base images first, then image
  // materials — ref_image_asset_ids mirrors ref_images order.
  const refImageAssetIds = args.exclusive_edit_source_id ? [...new Set([...baseImageAssetIds, ...materialImageAssetIds])] : [...baseImageAssetIds, ...materialImageAssetIds];
  if (refImageAssetIds.length > 0 && !backend.capabilities.ref_image) {
    throw new UnprocessableError(
      `backend "${backend.name}" cannot use reference images; ` +
        `${refImageAssetIds.length} pinned image asset(s) would be silently ignored`,
    );
  }
  const maxRef = backend.capabilities.max_ref_images;
  if (maxRef !== undefined && refImageAssetIds.length > maxRef) {
    throw new UnprocessableError(
      `backend "${backend.name}" accepts at most ${maxRef} reference ` +
        `image(s); ${refImageAssetIds.length} image asset(s) are pinned ` +
        `(character base images + selected materials) — unpin extras or ` +
        `pin a revision without a base image`,
    );
  }
  const refImages: string[] = [];
  for (const id of refImageAssetIds) {
    const asset = findAsset(db, id);
    if (!asset) throw new UnprocessableError(`asset ${id} not found`);
    refImages.push(asset.path);
  }

  // Output policy → size/duration hints. The seed varies per run so a
  // re-issue actually explores alternatives; it is recorded in inputs,
  // so a chosen result stays reproducible from its own record.
  const settings: GenerationInput["settings"] = {
    seed: randomInt(0, 2 ** 48 - 1),
  };
  if (args.duration_seconds != null) {
    settings["duration_seconds"] = args.duration_seconds;
  }
  const policyContent = contentByItem.get(find("output_policy") ?? "");
  if (policyContent) {
    const aspect = /16:9|横/.test(policyContent)
      ? "16:9"
      : /9:16|縦/.test(policyContent)
        ? "9:16"
        : /1:1|正方形/.test(policyContent)
          ? "1:1"
          : null;
    // MiniMax H3's native canvas uses a 32-pixel grid and a 768px
    // short edge. Image generation retains the existing 720p policy.
    if (aspect === "16:9") Object.assign(settings, args.kind === "video" && args.native_video_size ? { width: 1344, height: 768 } : { width: 1280, height: 720 });
    if (aspect === "9:16") Object.assign(settings, args.kind === "video" && args.native_video_size ? { width: 768, height: 1344 } : { width: 720, height: 1280 });
    if (aspect === "1:1") Object.assign(settings, { width: 1024, height: 1024 });
    // An explicit pixel pair takes precedence over aspect-only defaults.
    const pixels = /\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/i.exec(policyContent);
    if (pixels) Object.assign(settings, { width: Number(pixels[1]), height: Number(pixels[2]) });
    settings["output_policy"] = policyContent;
  }

  if (promptParts.length === 0) {
    throw new UnprocessableError(
      "blueprint version has no adopted content to generate from",
    );
  }

  return {
    kind: args.kind,
    prompt: promptParts.join("\n"),
    ref_images: refImages,
    settings,
    resolved_refs: {
      blueprint_version_id: bv.id,
      ...(selectedScene ? { story_scene_id: selectedScene.item_id, story_scene_revision_id: selectedScene.revision_id } : {}),
      item_revision_ids: itemRevIds,
      character_revision_ids: charRevIds,
      base_image_asset_ids: baseImageAssetIds,
      ref_image_asset_ids: refImageAssetIds,
      asset_ids: assetIds,
      used_asset_ids: usedAssetIds,
      document_revision_id: args.document_revision_id ?? null,
      camera_work_revision_ids: cameraWorkRevIds,
      camera_work_applied_revision_ids: cameraWorkAppliedRevIds,
    },
  };
}

/**
 * Inline a text material — in full or not at all. Reading is bounded
 * at the limit; an oversized file is rejected (never truncated), with
 * the asset, its size and the way forward named in the error.
 */
function readMaterialText(id: string, path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    throw new UnprocessableError(`material asset file missing: ${path}`);
  }
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_MATERIAL_TEXT_BYTES) {
      throw new UnprocessableError(
        `material ${id} (${safeBasename(path)}) is ${size} bytes — ` +
          `text materials are inlined into the prompt only up to ` +
          `${MAX_MATERIAL_TEXT_BYTES} bytes; keep a shorter production ` +
          `note as a separate text asset and select that instead`,
      );
    }
    const buf = Buffer.alloc(MAX_MATERIAL_TEXT_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_MATERIAL_TEXT_BYTES) {
      // grew between fstat and read — still refused, never cut
      throw new UnprocessableError(
        `material ${id} (${safeBasename(path)}) exceeds the ` +
          `${MAX_MATERIAL_TEXT_BYTES}-byte inline-text limit`,
      );
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
