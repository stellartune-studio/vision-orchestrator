import type { DatabaseSync } from "node:sqlite";
import { approvedPosterPlan } from "../repos/posterPlans.ts";
import { findDocumentRevision } from "../repos/documents.ts";
import { getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { findAsset } from "../repos/assets.ts";
import { ConflictError } from "../repos/errors.ts";
import { verifiedPromotionAsset } from "./promotionAsset.ts";
import { validatePosterLayout } from "./posterCompose.ts";

export function preparePosterInputs(db: DatabaseSync, input: { projectId: string; revisionId: string; root: string; maxBytes: number }) {
  const plan = approvedPosterPlan(db, input.projectId, input.revisionId);
  const revision = findDocumentRevision(db, input.revisionId);
  if (!revision?.blueprint_version_id) throw new ConflictError("Poster plan has no frozen blueprint");
  const blueprint = getBlueprintVersionDetail(db, revision.blueprint_version_id);
  if (blueprint.project_id !== input.projectId || ![plan.still_asset_id, plan.motion_asset_id].every((id) => blueprint.assets.some((entry) => entry.asset_id === id))) throw new ConflictError("Poster assets are not in the frozen blueprint");
  const still = findAsset(db, plan.still_asset_id), motion = findAsset(db, plan.motion_asset_id);
  if (still?.sha256?.toLowerCase() !== plan.still_sha256.toLowerCase() || motion?.sha256?.toLowerCase() !== plan.motion_sha256.toLowerCase()) throw new ConflictError("An approved poster asset changed");
  const stillBytes = verifiedPromotionAsset(still, input.projectId, input.root, input.maxBytes, "image/png");
  const motionBytes = verifiedPromotionAsset(motion, input.projectId, input.root, input.maxBytes, "video/mp4");
  if (stillBytes.length + motionBytes.length > input.maxBytes) throw new ConflictError("Combined poster inputs exceed the configured asset size limit");
  return { plan, revision, blueprint, layout: validatePosterLayout(JSON.parse(plan.layout_json)), stillBytes, motionBytes };
}
