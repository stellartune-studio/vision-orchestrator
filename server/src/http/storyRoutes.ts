import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { transact } from "../db/connection.ts";
import { appendAnimationShot, appendStoryScene, getItem, insertRevision, reorderStoryScenes } from "../repos/items.ts";
import { getDocument, getDocumentRevision, insertDocumentRevision } from "../repos/documents.ts";
import { getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { getProject } from "../repos/projects.ts";
import { getCharacter, listProjectCharacters } from "../repos/characters.ts";
import { sceneEditSource, insertSceneEditSource } from "../repos/sceneEditSources.ts";
import { findItemRevision, listItemRevisions } from "../repos/items.ts";
import { verifySceneEditSource } from "../gen/sceneEditSource.ts";
import { insertAnimationBackgroundPlan, animationBackgroundPlan } from "../repos/animationBackgrounds.ts";
import { checkedAnimationImages } from "../gen/animationBackground.ts";
import { registerAnimationCompositeJobs } from "./animationCompositeJobs.ts";
import { insertAnimationCast } from "../repos/animationCast.ts";
import { findAsset } from "../repos/assets.ts";
import { insertPromotionLayout } from "../repos/promotionLayouts.ts";
import { approvedMvPlan, insertMvPlan } from "../repos/mvPlans.ts";
import { preparePromotionInputs } from "../gen/promotionInputs.ts";
import { createPromotionPreview } from "../gen/promotionPreview.ts";
import { validatePromotionLayout } from "../gen/promotionCompose.ts";
import { verifiedPromotionAsset } from "../gen/promotionAsset.ts";
import { probeMvAudioDuration } from "../gen/mvAudio.ts";
import { analyzeMvBeats } from "../gen/mvBeatAnalysis.ts";
import { renderMv } from "../gen/mvRender.ts";
import { pendingSceneCharacterProposals, proposeSceneCharacters, sceneCharacters } from "../repos/sceneCharacters.ts";
import { BadRequestError, ConflictError } from "../repos/errors.ts";
import { sendJson, type Router } from "./router.ts";
import { registerPosterRoutes } from "./posterRoutes.ts";

// Keep lyric proposals bounded to the same one-hour horizon as local video editing.
const MAX_MV_DURATION_SECONDS = 60 * 60;
const MAX_MV_LYRIC_LINES = 200;

export function registerStoryRoutes(router: Router, db: DatabaseSync, storage: { assets_root: string; max_body_bytes: number; ffmpeg_bin?: string; ffprobe_bin?: string }): void {
  registerPosterRoutes(router, db, storage);
  registerAnimationCompositeJobs(router, db, storage);
  router.get("/api/projects/:id/story-scenes/:sceneId/edit-sources", (context) => {
    const scene = getItem(db, context.params.sceneId);
    if (scene.project_id !== context.params.id || scene.kind !== "story_segment") throw new BadRequestError("Scene does not belong to this project");
    const adopted = scene.adopted_revision_id ? sceneEditSource(db, scene.adopted_revision_id) ?? null : null;
    const pending = listItemRevisions(db, scene.id).filter((revision) => revision.proposal_status === "pending").flatMap((revision) => { const source = sceneEditSource(db, revision.id); return source ? [source] : []; });
    sendJson(context.res, 200, { adopted, pending });
  });
  router.post("/api/projects/:id/story-scenes/:sceneId/edit-source-proposals", (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.asset_id !== "string" || !Number.isSafeInteger(body.expected_version)) throw new BadRequestError("asset_id and expected_version are required");
    const currentScene = getItem(db, context.params.sceneId);
    if (currentScene.project_id !== context.params.id || currentScene.kind !== "story_segment" || !currentScene.adopted_revision_id) throw new BadRequestError("Choose an adopted scene in this project");
    if (currentScene.state_version !== body.expected_version) throw new ConflictError("Scene changed; review the edit source again");
    const verified = verifySceneEditSource(db, { projectId: context.params.id, sceneRevisionId: currentScene.adopted_revision_id, assetId: body.asset_id as string, root: storage.assets_root, maxBytes: storage.max_body_bytes });
    const result = transact(db, () => {
      const scene = getItem(db, context.params.sceneId);
      if (scene.project_id !== context.params.id || scene.kind !== "story_segment" || !scene.adopted_revision_id) throw new BadRequestError("Choose an adopted scene in this project");
      if (scene.state_version !== body.expected_version) throw new ConflictError("Scene changed; review the edit source again");
      const currentAsset = findAsset(db, verified.asset.id);
      if (scene.adopted_revision_id !== currentScene.adopted_revision_id || !currentAsset || currentAsset.path !== verified.asset.path || currentAsset.sha256 !== verified.asset.sha256 || currentAsset.selected !== verified.asset.selected || currentAsset.owner_kind !== verified.asset.owner_kind || currentAsset.owner_id !== verified.asset.owner_id) throw new ConflictError("Scene or edit source changed; review it again");
      const base = findItemRevision(db, scene.adopted_revision_id)!;
      const previous = sceneEditSource(db, base.id);
      const oldSuffix = previous ? `\n\nApproved edit source proposal: ${previous.asset_id} (SHA-256 ${previous.sha256})` : "";
      const sceneContent = oldSuffix && base.content.endsWith(oldSuffix) ? base.content.slice(0, -oldSuffix.length) : base.content;
      const revision = insertRevision(db, { item_id: scene.id, content: `${sceneContent}\n\nApproved edit source proposal: ${verified.asset.id} (SHA-256 ${verified.asset.sha256})`, source: "user", base_state_version: scene.state_version });
      insertSceneEditSource(db, { revision_id: revision.id, asset_id: verified.asset.id, sha256: verified.asset.sha256! });
      return revision;
    });
    sendJson(context.res, 201, result);
  });
  router.get("/api/projects/:id/mv-plans/:revisionId", (context) => {
    const plan = approvedMvPlan(db, context.params.id, context.params.revisionId);
    const audio = findAsset(db, plan.audio_asset_id);
    if (!audio?.mime?.startsWith("audio/") || audio.sha256?.toLowerCase() !== plan.audio_sha256.toLowerCase()) throw new ConflictError("The approved audio asset changed");
    verifiedPromotionAsset(audio, context.params.id, storage.assets_root, storage.max_body_bytes, audio.mime);
    sendJson(context.res, 200, plan);
  });
  router.post("/api/projects/:id/mv-beat-proposals", async (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.document_id !== "string" || typeof body.base_revision_id !== "string" || !Number.isSafeInteger(body.expected_version) || typeof body.audio_asset_id !== "string") throw new BadRequestError("Approved script and frozen audio are required");
    const check = () => {
      const doc = getDocument(db, body.document_id as string);
      if (doc.project_id !== context.params.id || doc.kind !== "script") throw new BadRequestError("Script must belong to this project");
      if (doc.state_version !== body.expected_version || doc.adopted_revision_id !== body.base_revision_id) throw new ConflictError("Script changed; reload before analyzing beats");
      const base = getDocumentRevision(db, doc.id, body.base_revision_id as string);
      if (!base.blueprint_version_id) throw new ConflictError("The approved script has no blueprint version");
      const blueprint = getBlueprintVersionDetail(db, base.blueprint_version_id);
      const audio = findAsset(db, body.audio_asset_id as string);
      if (blueprint.project_id !== context.params.id || !blueprint.assets.some((entry) => entry.asset_id === body.audio_asset_id) || !audio?.mime?.startsWith("audio/")) throw new BadRequestError("Audio must be frozen in this script's blueprint");
      return audio;
    };
    const audio = check();
    const bytes = verifiedPromotionAsset(audio, context.params.id, storage.assets_root, storage.max_body_bytes, audio.mime!);
    const result = await analyzeMvBeats(bytes, storage.assets_root, storage.ffmpeg_bin ?? "ffmpeg", storage.ffprobe_bin ?? "ffprobe");
    const current = check();
    if (current.path !== audio.path || current.sha256 !== audio.sha256) throw new ConflictError("Audio changed during analysis");
    verifiedPromotionAsset(current, context.params.id, storage.assets_root, storage.max_body_bytes, current.mime!);
    sendJson(context.res, 200, { ...result, audio_asset_id: audio.id, audio_sha256: audio.sha256 });
  });
  router.post("/api/projects/:id/mv-lyrics-proposals", async (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.document_id !== "string" || typeof body.base_revision_id !== "string" || !Number.isSafeInteger(body.expected_version) || typeof body.audio_asset_id !== "string" || !Array.isArray(body.lines) || body.lines.length > MAX_MV_LYRIC_LINES) throw new BadRequestError("Script, frozen audio and a lyrics array are required");
    let previousEnd = 0;
    const lines = body.lines.map((value: unknown) => {
      if (!value || typeof value !== "object") throw new BadRequestError("Invalid lyric line");
      const line = value as Record<string, unknown>;
      if (typeof line.start !== "number" || !Number.isFinite(line.start) || typeof line.end !== "number" || !Number.isFinite(line.end) || line.start < previousEnd || line.end <= line.start || line.end > MAX_MV_DURATION_SECONDS || typeof line.text !== "string" || !line.text.trim() || line.text.length > 1000 || /[\x00-\x1f]/.test(line.text)) throw new BadRequestError("Lyric lines must have ordered non-overlapping times and single-line text");
      previousEnd = line.end;
      return { start: line.start, end: line.end, text: line.text.trim() };
    });
    const beats = body.beats === undefined ? [] : body.beats;
    if (!Array.isArray(beats) || beats.length > 1000 || beats.some((beat, index) => typeof beat !== "number" || !Number.isFinite(beat) || beat < 0 || (index > 0 && beat <= beats[index - 1]))) throw new BadRequestError("Manual beat points must be strictly increasing non-negative seconds");
    const beatOrigin = body.beat_origin ?? "manual";
    if (beatOrigin !== "manual" && beatOrigin !== "estimated_selected" && beatOrigin !== "estimated_edited") throw new BadRequestError("Invalid beat origin");
    const rawCuts = body.cuts === undefined ? [] : body.cuts;
    if (!Array.isArray(rawCuts) || rawCuts.length > 64) throw new BadRequestError("At most 64 cuts are supported");
    const cuts = rawCuts.map((value: unknown, index: number) => {
      if (!value || typeof value !== "object") throw new BadRequestError("Invalid cut");
      const cut = value as Record<string, unknown>;
      if (typeof cut.video_asset_id !== "string" || !cut.video_asset_id || typeof cut.start !== "number" || !Number.isFinite(cut.start) || (index === 0 ? cut.start !== 0 : !beats.includes(cut.start) || cut.start <= (rawCuts[index - 1] as { start: number }).start)) throw new BadRequestError("The first cut must start at zero; later cuts must use increasing manual beat points");
      return { video_asset_id: cut.video_asset_id, start: cut.start };
    });
    const initialDoc = getDocument(db, body.document_id as string);
    if (initialDoc.project_id !== context.params.id || initialDoc.kind !== "script") throw new BadRequestError("Script must belong to this project");
    if (initialDoc.state_version !== body.expected_version || initialDoc.adopted_revision_id !== body.base_revision_id) throw new ConflictError("Script changed; reload before adding lyrics");
    const audioCandidate = findAsset(db, body.audio_asset_id as string);
    if (!audioCandidate?.mime?.startsWith("audio/")) throw new BadRequestError("Audio must be a project asset frozen in the script blueprint");
    const bytes = verifiedPromotionAsset(audioCandidate, context.params.id, storage.assets_root, storage.max_body_bytes, audioCandidate.mime);
    const duration = await probeMvAudioDuration(bytes, storage.assets_root, storage.ffprobe_bin ?? "ffprobe");
    if (lines.some((line) => line.end > duration) || beats.some((beat) => beat > duration) || cuts.some((cut) => cut.start >= duration)) throw new BadRequestError(`Lyrics and beat points must be within the audio duration (${duration.toFixed(3)} seconds)`);
    const revision = transact(db, () => {
      const doc = getDocument(db, body.document_id as string);
      if (doc.project_id !== context.params.id || doc.kind !== "script") throw new BadRequestError("Script must belong to this project");
      if (doc.state_version !== body.expected_version || doc.adopted_revision_id !== body.base_revision_id) throw new ConflictError("Script changed; reload before adding lyrics");
      const base = getDocumentRevision(db, doc.id, body.base_revision_id as string);
      if (!base.blueprint_version_id) throw new ConflictError("The approved script has no blueprint version");
      const version = getBlueprintVersionDetail(db, base.blueprint_version_id);
      const audio = findAsset(db, body.audio_asset_id as string);
      if (version.project_id !== context.params.id || !version.assets.some((entry) => entry.asset_id === body.audio_asset_id) || !audio || audio.owner_kind !== "project" || audio.owner_id !== context.params.id || !audio.mime?.startsWith("audio/")) throw new BadRequestError("Audio must be a project asset frozen in the script blueprint");
      if (audio.sha256 !== audioCandidate.sha256 || audio.path !== audioCandidate.path) throw new ConflictError("Audio asset changed; reload before adding lyrics");
      const approvedCuts = cuts.map((cut) => {
        const clip = findAsset(db, cut.video_asset_id);
        if (!version.assets.some((entry) => entry.asset_id === cut.video_asset_id)) throw new BadRequestError("Every cut video must be frozen in the script blueprint");
        verifiedPromotionAsset(clip, context.params.id, storage.assets_root, storage.max_body_bytes, "video/mp4");
        return { ...cut, sha256: clip!.sha256! };
      });
      const content = `${base.content}\n\nMusic asset: ${audio.id}\nMusic SHA-256: ${audio.sha256}\nMeasured duration: ${duration.toFixed(3)}s\nManual beat points (seconds): ${beats.map((beat: number) => beat.toFixed(3)).join(", ") || "none"}\nTimed lyrics:\n${lines.map((line) => `${line.start.toFixed(3)}–${line.end.toFixed(3)}s: ${line.text}`).join("\n")}\nCuts:\n${approvedCuts.map((cut) => `${cut.start.toFixed(3)}s: ${cut.video_asset_id} (${cut.sha256})`).join("\n") || "none"}`;
      const result = insertDocumentRevision(db, { document_id: doc.id, content, source: "user", blueprint_version_id: base.blueprint_version_id, base_revision_id: base.id });
      insertMvPlan(db, { revision_id: result.id, audio_asset_id: audio.id, audio_sha256: audio.sha256!, audio_duration: duration, beats_json: JSON.stringify(beats), lyrics_json: JSON.stringify(lines), clips_json: JSON.stringify(approvedCuts), beat_origin: beatOrigin });
      return result;
    });
    sendJson(context.res, 201, revision);
  });
  router.post("/api/projects/:id/animation-shots", (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.scene_id !== "string" || typeof body.character_id !== "string" || typeof body.character_revision_id !== "string" || !Number.isSafeInteger(body.pin_version) || typeof body.expression !== "string" || !body.expression.trim() || typeof body.movement !== "string" || !body.movement.trim() || typeof body.background !== "string" || !body.background.trim()) throw new BadRequestError("Scene, pinned character, expression, movement and background are required");
    if ((body.background_asset_id !== undefined || body.foreground_asset_id !== undefined) && (typeof body.background_asset_id !== "string" || typeof body.foreground_asset_id !== "string")) throw new BadRequestError("Choose both background and foreground PNG assets");
    const composition = typeof body.background_asset_id === "string" && typeof body.foreground_asset_id === "string" ? checkedAnimationImages(db, { projectId: context.params.id, backgroundId: body.background_asset_id, foregroundId: body.foreground_asset_id, root: storage.assets_root, maxBytes: storage.max_body_bytes }) : null;
    const result = transact(db, () => {
      const scene = getItem(db, body.scene_id as string);
      if (scene.project_id !== context.params.id || scene.kind !== "story_segment" || !scene.adopted_revision_id) throw new BadRequestError("Choose an adopted scene in this project");
      const pin = listProjectCharacters(db, context.params.id).find((entry) => entry.character_id === body.character_id);
      if (!pin || pin.character_revision_id !== body.character_revision_id || pin.pin_version !== body.pin_version) throw new ConflictError("Character pin changed; reload before creating the shot");
      const character = getCharacter(db, pin.character_id);
      if (composition) for (const original of [composition.background, composition.foreground]) {
        const current = findAsset(db, original.id);
        if (!current?.selected || current.path !== original.path || current.sha256 !== original.sha256 || current.owner_id !== original.owner_id || current.owner_kind !== original.owner_kind) throw new ConflictError("Composition assets changed; review them again");
      }
      const shot = appendAnimationShot(db, context.params.id, scene.id, `Animation shot — ${character.name}`);
      const content = `Character: ${character.name}\nExpression: ${(body.expression as string).trim()}\nMovement: ${(body.movement as string).trim()}\nBackground direction: ${(body.background as string).trim()}${composition ? `\nImage preprocessing: foreground over background at (0, 0), equal canvas dimensions\nBackground: ${composition.background.id} (${composition.background.sha256})\nForeground: ${composition.foreground.id} (${composition.foreground.sha256})` : ""}`;
      const revision = insertRevision(db, { item_id: shot.id, content, source: "user" });
      insertAnimationCast(db, revision.id, pin.character_id, pin.character_revision_id);
      if (composition) insertAnimationBackgroundPlan(db, { revision_id: revision.id, background_asset_id: composition.background.id, background_sha256: composition.background.sha256!, foreground_asset_id: composition.foreground.id, foreground_sha256: composition.foreground.sha256! });
      return { shot, revision };
    });
    sendJson(context.res, 201, result);
  });
  router.get("/api/projects/:id/animation-shots/:shotId/background-plan", (context) => {
    const shot = getItem(db, context.params.shotId);
    if (shot.project_id !== context.params.id || shot.kind !== "shot") throw new BadRequestError("Shot does not belong to this project");
    sendJson(context.res, 200, shot.adopted_revision_id ? animationBackgroundPlan(db, shot.adopted_revision_id) ?? null : null);
  });
  const configuredFont = () => {
    const file = process.env.PROMOTION_FONT_FILE?.trim() ?? "";
    try { if (file && statSync(file).isFile()) return file; } catch { /* unavailable */ }
    return "";
  };
  const renderMvRequest = async (context: Parameters<Parameters<Router["post"]>[1]>[0], exportFile: boolean) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.revision_id !== "string" || typeof body.video_asset_id !== "string") throw new BadRequestError("revision_id and video_asset_id are required");
    if (body.font_id !== undefined && body.font_id !== "configured") throw new BadRequestError("Choose the configured font");
    const asset = await renderMv(db, { project_id: context.params.id, revision_id: body.revision_id, video_id: body.video_asset_id, root: storage.assets_root, max_bytes: storage.max_body_bytes, ffmpeg: storage.ffmpeg_bin ?? "ffmpeg", ffprobe: storage.ffprobe_bin ?? "ffprobe", font: body.font_id === "configured" ? configuredFont() : "", export_file: exportFile });
    sendJson(context.res, 201, asset);
  };
  router.post("/api/projects/:id/mv-previews", (context) => renderMvRequest(context, false));
  router.post("/api/projects/:id/mv-exports", (context) => renderMvRequest(context, true));
  router.get("/api/promotion-fonts", (context) => sendJson(context.res, 200, configuredFont() ? [{ id: "configured", label: "Configured font" }] : []));
  const renderPromotion = async (context: Parameters<Parameters<Router["post"]>[1]>[0], exportFile: boolean) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.revision_id !== "string" || typeof body.source_asset_id !== "string") throw new BadRequestError("revision_id and source_asset_id are required");
    if (body.font_id !== undefined && body.font_id !== "configured") throw new BadRequestError("Unknown promotion font");
    const asset = await createPromotionPreview(db, { project_id: context.params.id, revision_id: body.revision_id, source_asset_id: body.source_asset_id, assets_root: storage.assets_root, max_bytes: storage.max_body_bytes, ffmpeg: storage.ffmpeg_bin ?? "ffmpeg", ffprobe: storage.ffprobe_bin ?? "ffprobe", font: configuredFont(), font_id: "configured", export: exportFile });
    sendJson(context.res, 201, asset);
  };
  router.post("/api/projects/:id/promotion-previews", (context) => renderPromotion(context, false));
  router.post("/api/projects/:id/promotion-exports", (context) => renderPromotion(context, true));
  router.get("/api/projects/:id/promotion-layouts/:revisionId", (context) => {
    const prepared = preparePromotionInputs(db, { project_id: context.params.id, revision_id: context.params.revisionId, assets_root: storage.assets_root, max_logo_bytes: storage.max_body_bytes });
    sendJson(context.res, 200, prepared.record);
  });
  router.post("/api/projects/:id/promotion-proposals", (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.document_id !== "string" || typeof body.base_revision_id !== "string" || !Number.isSafeInteger(body.expected_version) || typeof body.points !== "string" || !body.points.trim() || typeof body.closing !== "string" || !body.closing.trim() || typeof body.call_to_action !== "string" || !body.call_to_action.trim() || typeof body.logo_asset_id !== "string" || !body.logo_asset_id) throw new BadRequestError("Document, points, closing, call to action and logo asset are required");
    const revision = transact(db, () => {
      const doc = getDocument(db, body.document_id as string);
      if (doc.project_id !== context.params.id || doc.kind !== "script") throw new BadRequestError("Script must belong to this project");
      if (doc.state_version !== body.expected_version || doc.adopted_revision_id !== body.base_revision_id) throw new ConflictError("Script changed; reload before saving the proposal");
      const base = getDocumentRevision(db, doc.id, body.base_revision_id as string);
      if (!base.blueprint_version_id) throw new ConflictError("The approved script has no blueprint version");
      const blueprint = getBlueprintVersionDetail(db, base.blueprint_version_id);
      if (blueprint.project_id !== context.params.id || !blueprint.assets.some((asset) => asset.asset_id === body.logo_asset_id)) throw new BadRequestError("Logo must be a selected asset frozen in the script's blueprint");
      const logo = findAsset(db, body.logo_asset_id as string);
      if (!logo || logo.owner_kind !== "project" || logo.owner_id !== context.params.id || !logo.mime?.startsWith("image/")) throw new BadRequestError("Logo must be an image asset owned by this project");
      const content = `${base.content}\n\nPromotion:\nSelling points: ${(body.points as string).trim()}\nClosing message: ${(body.closing as string).trim()}\nCall to action: ${(body.call_to_action as string).trim()}\nLogo asset: ${body.logo_asset_id}`;
      const revision = insertDocumentRevision(db, { document_id: doc.id, content, source: "user", blueprint_version_id: base.blueprint_version_id, base_revision_id: base.id });
      if (body.layout !== undefined) {
        const layout = validatePromotionLayout(body.layout);
        verifiedPromotionAsset(logo, context.params.id, storage.assets_root, storage.max_body_bytes, "image/png");
        insertPromotionLayout(db, { revision_id: revision.id, logo_asset_id: logo.id, logo_sha256: logo.sha256!, title: (body.closing as string).trim(), layout });
      }
      return revision;
    });
    sendJson(context.res, 201, revision);
  });
  router.get("/api/projects/:id/story-scenes/:sceneId/characters", (context) => {
    const scene = getItem(db, context.params.sceneId);
    if (scene.project_id !== context.params.id || scene.kind !== "story_segment") throw new BadRequestError("Scene does not belong to this project");
    sendJson(context.res, 200, { revision_id: scene.adopted_revision_id, characters: scene.adopted_revision_id ? sceneCharacters(db, scene.adopted_revision_id) : [], proposals: pendingSceneCharacterProposals(db, scene.id) });
  });
  router.post("/api/projects/:id/story-scenes/:sceneId/character-proposals", (context) => {
    const body = context.body as { expected_version?: unknown; characters?: unknown } | null;
    if (!Number.isSafeInteger(body?.expected_version) || Number(body?.expected_version) < 0 || !Array.isArray(body?.characters) || body.characters.some((value: unknown) => !value || typeof value !== "object" || typeof (value as { character_id?: unknown }).character_id !== "string" || typeof (value as { character_revision_id?: unknown }).character_revision_id !== "string" || !Number.isSafeInteger((value as { pin_version?: unknown }).pin_version))) throw new BadRequestError("expected_version and character pins are required");
    const revision = transact(db, () => proposeSceneCharacters(db, { project_id: context.params.id, scene_id: context.params.sceneId, expected_version: body.expected_version as number, characters: body.characters as { character_id: string; character_revision_id: string; pin_version: number }[] }));
    sendJson(context.res, 201, { revision, characters: sceneCharacters(db, revision.id) });
  });
  router.post("/api/projects/:id/story-scenes", (context) => {
    const scene = transact(db, () => {
      getProject(db, context.params.id);
      return appendStoryScene(db, context.params.id);
    });
    sendJson(context.res, 201, scene);
  });
  router.put("/api/projects/:id/story-scenes/order", (context) => {
    const body = context.body as { scenes?: unknown } | null;
    if (!Array.isArray(body?.scenes) || body.scenes.some((entry: unknown) => !entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string" || !Number.isSafeInteger((entry as { expected_version?: unknown }).expected_version) || Number((entry as { expected_version?: unknown }).expected_version) < 0)) {
      throw new BadRequestError("scenes must contain IDs and non-negative expected_version values");
    }
    const scenes = transact(db, () => {
      getProject(db, context.params.id);
      return reorderStoryScenes(db, context.params.id, body.scenes as { id: string; expected_version: number }[]);
    });
    sendJson(context.res, 200, scenes);
  });
  router.post("/api/projects/:id/story-scenes/:sceneId/dialogue-proposals", (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.document_id !== "string" || typeof body.base_revision_id !== "string" || !Number.isSafeInteger(body.expected_version) || typeof body.content !== "string" || !body.content.trim()) {
      throw new BadRequestError("document_id, base_revision_id, expected_version and dialogue content are required");
    }
    const revision = transact(db, () => {
      const scene = getItem(db, context.params.sceneId);
      const doc = getDocument(db, body.document_id as string);
      if (scene.project_id !== context.params.id || scene.kind !== "story_segment" || doc.project_id !== context.params.id || doc.kind !== "script") throw new BadRequestError("Scene and script must belong to this project");
      if (doc.state_version !== body.expected_version || doc.adopted_revision_id !== body.base_revision_id) throw new ConflictError("Script changed; reload before adding dialogue");
      const base = getDocumentRevision(db, doc.id, body.base_revision_id as string);
      if (!base.blueprint_version_id) throw new ConflictError("The approved script has no blueprint version");
      const blueprint = getBlueprintVersionDetail(db, base.blueprint_version_id);
      const frozenScene = blueprint.items.find((item) => item.item_id === scene.id);
      if (blueprint.project_id !== context.params.id || !frozenScene || frozenScene.revision_id !== scene.adopted_revision_id || frozenScene.seq !== scene.seq) throw new ConflictError("Freeze the current scene and approve a script for that blueprint first");
      return insertDocumentRevision(db, { document_id: doc.id, content: `${base.content}\n\nScene ${frozenScene.seq} — Dialogue:\n${(body.content as string).trim()}`, source: "user", blueprint_version_id: base.blueprint_version_id, base_revision_id: base.id });
    });
    sendJson(context.res, 201, revision);
  });
}
