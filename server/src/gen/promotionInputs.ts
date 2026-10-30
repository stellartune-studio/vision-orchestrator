import type { DatabaseSync } from "node:sqlite";
import { approvedPromotionLayout } from "../repos/promotionLayouts.ts";
import { findAsset } from "../repos/assets.ts";
import { ConflictError } from "../repos/errors.ts";
import { verifiedPromotionAsset } from "./promotionAsset.ts";
import { validatePromotionLayout } from "./promotionCompose.ts";

/** Returns the verified bytes themselves so a later path swap cannot alter rendering. */
export function preparePromotionInputs(db: DatabaseSync, input: { project_id: string; revision_id: string; assets_root: string; max_logo_bytes: number }) {
  const record = approvedPromotionLayout(db, input.project_id, input.revision_id);
  const logo = findAsset(db, record.logo_asset_id);
  if (!logo || logo.sha256?.toLowerCase() !== record.logo_sha256.toLowerCase()) throw new ConflictError("The approved logo asset changed");
  const logoBytes = verifiedPromotionAsset(logo, input.project_id, input.assets_root, input.max_logo_bytes, "image/png");
  return { record, layout: validatePromotionLayout(JSON.parse(record.layout_json)), logoBytes };
}
