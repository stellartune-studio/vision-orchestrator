import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { NotFoundError } from "./errors.ts";

export interface AnimationCompositeJob { id: string; project_id: string; shot_id: string; blueprint_version_id: string; status: "running" | "cancelling" | "succeeded" | "failed" | "cancelled"; asset_id: string | null; error: string | null; process_evidence: string | null; created_at: string; updated_at: string }
export function getCompositeJob(db: DatabaseSync, projectId: string, id: string): AnimationCompositeJob {
  const row = db.prepare("SELECT * FROM animation_composite_jobs WHERE id = ? AND project_id = ?").get(id, projectId) as unknown as AnimationCompositeJob | undefined;
  if (!row) throw new NotFoundError("Composition job not found");
  return row;
}
export function listCompositeJobs(db: DatabaseSync, projectId: string): AnimationCompositeJob[] {
  return db.prepare("SELECT * FROM animation_composite_jobs WHERE project_id = ? ORDER BY rowid DESC").all(projectId) as unknown as AnimationCompositeJob[];
}
export function hasActiveCompositeJob(db: DatabaseSync, shotId: string): boolean {
  return !!db.prepare("SELECT 1 FROM animation_composite_jobs WHERE shot_id = ? AND status IN ('running', 'cancelling') LIMIT 1").get(shotId);
}
export function compositeJobAssetIds(db: DatabaseSync, projectId: string, jobId: string): string[] {
  return (db.prepare(`SELECT id FROM assets WHERE owner_kind = 'project' AND owner_id = ? AND kind = 'animation-composite'
    AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.composition_job_id') ELSE NULL END = ?`).all(projectId, jobId) as { id: string }[]).map((row) => row.id);
}
export function insertCompositeJob(db: DatabaseSync, projectId: string, shotId: string, blueprintId: string): AnimationCompositeJob {
  const id = newId();
  db.prepare("INSERT INTO animation_composite_jobs (id, project_id, shot_id, blueprint_version_id, status) VALUES (?, ?, ?, ?, 'running')").run(id, projectId, shotId, blueprintId);
  return getCompositeJob(db, projectId, id);
}
export function updateCompositeJob(db: DatabaseSync, projectId: string, id: string, status: AnimationCompositeJob["status"], assetId: string | null = null, error: string | null = null): AnimationCompositeJob {
  db.prepare("UPDATE animation_composite_jobs SET status = ?, asset_id = ?, error = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?").run(status, assetId, error, id, projectId);
  return getCompositeJob(db, projectId, id);
}
export function recordCompositeProcessEvidence(db: DatabaseSync, projectId: string, id: string, evidence: string): void {
  db.prepare("UPDATE animation_composite_jobs SET process_evidence = ? WHERE id = ? AND project_id = ? AND status IN ('running', 'cancelling') AND process_evidence IS NULL").run(evidence, id, projectId);
}
export function finishReconciledComposite(db: DatabaseSync, projectId: string, id: string, evidence: string, assetId: string | null): boolean {
  return Number(db.prepare("UPDATE animation_composite_jobs SET status = ?, asset_id = ?, error = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ? AND status IN ('running', 'cancelling') AND process_evidence = ?").run(assetId ? "succeeded" : "failed", assetId, assetId ? null : "Original processes ended without a registered output; retry is available", id, projectId, evidence).changes) === 1;
}
