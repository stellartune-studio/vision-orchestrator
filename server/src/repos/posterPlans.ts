import type { DatabaseSync } from "node:sqlite";
import { ConflictError } from "./errors.ts";
import { validatePosterLayout, type PosterLayout } from "../gen/posterCompose.ts";

export interface PosterPlan { revision_id: string; still_asset_id: string; still_sha256: string; motion_asset_id: string; motion_sha256: string; layout_json: string }

/** Insert only while creating a pending document revision in the same transaction. */
export function insertPosterPlan(db: DatabaseSync, input: Omit<PosterPlan, "layout_json"> & { layout: PosterLayout }): void {
  db.prepare("INSERT INTO poster_plans (revision_id, still_asset_id, still_sha256, motion_asset_id, motion_sha256, layout_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.revision_id, input.still_asset_id, input.still_sha256, input.motion_asset_id, input.motion_sha256, JSON.stringify(validatePosterLayout(input.layout)));
}

export function approvedPosterPlan(db: DatabaseSync, projectId: string, revisionId: string): PosterPlan {
  const row = db.prepare(`SELECT p.* FROM poster_plans p JOIN document_revisions r ON r.id = p.revision_id
    JOIN production_documents d ON d.id = r.document_id
    WHERE d.project_id = ? AND d.adopted_revision_id = r.id AND r.id = ?`).get(projectId, revisionId) as PosterPlan | undefined;
  if (!row) throw new ConflictError("Poster plan is not the project's adopted revision");
  validatePosterLayout(JSON.parse(row.layout_json));
  return row;
}
