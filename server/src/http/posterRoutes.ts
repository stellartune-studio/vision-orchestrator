import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db/connection.ts";
import { getDocument, getDocumentRevision, insertDocumentRevision } from "../repos/documents.ts";
import { getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { findAsset } from "../repos/assets.ts";
import { insertPosterPlan } from "../repos/posterPlans.ts";
import { BadRequestError, ConflictError } from "../repos/errors.ts";
import { validatePosterLayout } from "../gen/posterCompose.ts";
import { verifiedPromotionAsset } from "../gen/promotionAsset.ts";
import { preparePosterInputs } from "../gen/posterInputs.ts";
import { renderPoster } from "../gen/posterRender.ts";
import { sendJson, type Router } from "./router.ts";

export function registerPosterRoutes(router: Router, db: DatabaseSync, storage: { assets_root: string; max_body_bytes: number; ffmpeg_bin?: string; ffprobe_bin?: string }): void {
  router.post("/api/projects/:id/poster-proposals", (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.document_id !== "string" || typeof body.base_revision_id !== "string" || !Number.isSafeInteger(body.expected_version) || typeof body.still_asset_id !== "string" || typeof body.motion_asset_id !== "string") throw new BadRequestError("Script, still and motion assets are required");
    const layout = validatePosterLayout(body.layout);
    const still = findAsset(db, body.still_asset_id), motion = findAsset(db, body.motion_asset_id);
    const stillBytes = verifiedPromotionAsset(still, context.params.id, storage.assets_root, storage.max_body_bytes, "image/png");
    const motionBytes = verifiedPromotionAsset(motion, context.params.id, storage.assets_root, storage.max_body_bytes, "video/mp4");
    if (stillBytes.length + motionBytes.length > storage.max_body_bytes) throw new BadRequestError("Combined poster inputs exceed the configured asset size limit");
    const result = transact(db, () => {
      const doc = getDocument(db, body.document_id as string);
      if (doc.project_id !== context.params.id || doc.kind !== "script") throw new BadRequestError("Script must belong to this project");
      if (doc.state_version !== body.expected_version || doc.adopted_revision_id !== body.base_revision_id) throw new ConflictError("Script changed; reload before saving the poster");
      const base = getDocumentRevision(db, doc.id, body.base_revision_id as string);
      if (!base.blueprint_version_id) throw new ConflictError("The approved script has no blueprint version");
      const blueprint = getBlueprintVersionDetail(db, base.blueprint_version_id);
      if (blueprint.project_id !== context.params.id || ![still!.id, motion!.id].every((id) => blueprint.assets.some((item) => item.asset_id === id))) throw new BadRequestError("Poster assets must be frozen in the script blueprint");
      const currentStill = findAsset(db, still!.id), currentMotion = findAsset(db, motion!.id);
      if (currentStill?.sha256 !== still!.sha256 || currentStill?.path !== still!.path || currentMotion?.sha256 !== motion!.sha256 || currentMotion?.path !== motion!.path) throw new ConflictError("Poster assets changed while saving");
      const content = `${base.content}\n\nMoving poster:\nStill: ${still!.id} (${still!.sha256})\nMotion: ${motion!.id} (${motion!.sha256})\nCanvas and ordered layers: ${JSON.stringify(layout)}`;
      const revision = insertDocumentRevision(db, { document_id: doc.id, content, source: "user", blueprint_version_id: base.blueprint_version_id, base_revision_id: base.id });
      insertPosterPlan(db, { revision_id: revision.id, still_asset_id: still!.id, still_sha256: still!.sha256!, motion_asset_id: motion!.id, motion_sha256: motion!.sha256!, layout });
      return revision;
    });
    sendJson(context.res, 201, result);
  });
  router.get("/api/projects/:id/poster-plans/:revisionId", (context) => {
    const prepared = preparePosterInputs(db, { projectId: context.params.id, revisionId: context.params.revisionId, root: storage.assets_root, maxBytes: storage.max_body_bytes });
    sendJson(context.res, 200, prepared.plan);
  });
  const render = async (context: Parameters<Parameters<Router["post"]>[1]>[0], exportFile: boolean) => {
    const body = context.body as Record<string, unknown> | null;
    if (typeof body?.revision_id !== "string") throw new BadRequestError("An adopted poster revision is required");
    const result = await renderPoster(db, { projectId: context.params.id, revisionId: body.revision_id, root: storage.assets_root, maxBytes: storage.max_body_bytes, ffmpeg: storage.ffmpeg_bin ?? "ffmpeg", ffprobe: storage.ffprobe_bin ?? "ffprobe", exportFile });
    sendJson(context.res, 201, result);
  };
  router.post("/api/projects/:id/poster-previews", (context) => render(context, false));
  router.post("/api/projects/:id/poster-exports", (context) => render(context, true));
}
