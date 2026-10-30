import type { DatabaseSync } from "node:sqlite";
import { ConflictError } from "./errors.ts";

export interface MvPlanRecord { revision_id: string; audio_asset_id: string; audio_sha256: string; audio_duration: number; beats_json: string; lyrics_json: string; clips_json: string; beat_origin: "manual" | "estimated_selected" | "estimated_edited" }

/** Call only inside the transaction which creates the proposal revision. */
export function insertMvPlan(db: DatabaseSync, input: MvPlanRecord): void {
  db.prepare("INSERT INTO mv_plans (revision_id, audio_asset_id, audio_sha256, audio_duration, beats_json, lyrics_json, clips_json, beat_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.revision_id, input.audio_asset_id, input.audio_sha256, input.audio_duration, input.beats_json, input.lyrics_json, input.clips_json, input.beat_origin);
}

/** Never render an unadopted or another project's plan. */
export function approvedMvPlan(db: DatabaseSync, projectId: string, revisionId: string): MvPlanRecord {
  const row = db.prepare(`SELECT p.revision_id, p.audio_asset_id, p.audio_sha256, p.audio_duration, p.beats_json, p.lyrics_json, p.clips_json, p.beat_origin
    FROM mv_plans p JOIN document_revisions r ON r.id = p.revision_id
    JOIN production_documents d ON d.id = r.document_id
    WHERE d.project_id = ? AND d.adopted_revision_id = r.id AND r.id = ?`).get(projectId, revisionId) as MvPlanRecord | undefined;
  if (!row) throw new ConflictError("MV plan is not the project's adopted revision");
  return row;
}
