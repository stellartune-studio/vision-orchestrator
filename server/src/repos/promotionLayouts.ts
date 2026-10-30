import type { DatabaseSync } from "node:sqlite";
import { ConflictError } from "./errors.ts";
import { validatePromotionLayout, type PromotionLayout } from "../gen/promotionCompose.ts";

export interface PromotionLayoutRecord { revision_id: string; logo_asset_id: string; logo_sha256: string; title: string; layout_json: string }

/** Insert only within the same transaction that creates the pending revision. */
export function insertPromotionLayout(db: DatabaseSync, input: { revision_id: string; logo_asset_id: string; logo_sha256: string; title: string; layout: PromotionLayout }): void {
  db.prepare("INSERT INTO promotion_layouts (revision_id, logo_asset_id, logo_sha256, title, layout_json) VALUES (?, ?, ?, ?, ?)").run(input.revision_id, input.logo_asset_id, input.logo_sha256, input.title, JSON.stringify(validatePromotionLayout(input.layout)));
}

/** A renderer must only consume the currently adopted revision. */
export function approvedPromotionLayout(db: DatabaseSync, projectId: string, revisionId: string): PromotionLayoutRecord {
  const row = db.prepare(`SELECT p.revision_id, p.logo_asset_id, p.logo_sha256, p.title, p.layout_json
    FROM promotion_layouts p JOIN document_revisions r ON r.id = p.revision_id
    JOIN production_documents d ON d.id = r.document_id
    WHERE d.project_id = ? AND d.adopted_revision_id = r.id AND r.id = ?`).get(projectId, revisionId) as PromotionLayoutRecord | undefined;
  if (!row) throw new ConflictError("Promotion layout is not the project's adopted revision");
  validatePromotionLayout(JSON.parse(row.layout_json));
  return row;
}
