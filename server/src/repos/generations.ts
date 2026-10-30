import { DatabaseSync } from "node:sqlite";
import type { GenerationRecord, GenerationStatus } from "@vo/shared";
import { newId } from "../domain/ids.ts";
import { NotFoundError } from "./errors.ts";

const cols =
  "id, project_id, kind, status, blueprint_version_id, document_revision_id, inputs, backend, backend_job_id, output_asset_id, error, created_at, updated_at";

export function findGenerationByOutputAsset(db: DatabaseSync, projectId: string, assetId: string): GenerationRecord | undefined {
  return db.prepare(`SELECT ${cols} FROM generation_records WHERE project_id = ? AND output_asset_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`).get(projectId, assetId) as unknown as GenerationRecord | undefined;
}

export function getGeneration(
  db: DatabaseSync,
  id: string,
): GenerationRecord {
  const row = db
    .prepare(`SELECT ${cols} FROM generation_records WHERE id = ?`)
    .get(id) as unknown as GenerationRecord | undefined;
  if (!row) throw new NotFoundError(`generation ${id}`);
  return row;
}

export function hasActiveGenerations(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM generation_records WHERE status IN ('queued', 'running') LIMIT 1").get();
}

export function activeGenerationIds(db: DatabaseSync, backend: string): string[] {
  return (db.prepare("SELECT id FROM generation_records WHERE status IN ('queued', 'running') AND backend = ? ORDER BY created_at").all(backend) as { id: string }[]).map((row) => row.id);
}

export function generationDedupCandidates(db: DatabaseSync, projectId: string): { id: string; inputs: string; status: string }[] {
  return db.prepare("SELECT id, inputs, status FROM generation_records WHERE project_id = ? AND status IN ('queued', 'running', 'succeeded') ORDER BY created_at DESC").all(projectId) as unknown as { id: string; inputs: string; status: string }[];
}

export function insertGeneration(
  db: DatabaseSync,
  input: {
    project_id: string;
    kind: GenerationRecord["kind"];
    blueprint_version_id?: string | null;
    document_revision_id?: string | null;
    inputs: string;
    backend: string;
  },
): GenerationRecord {
  const id = newId();
  db.prepare(
    `INSERT INTO generation_records
       (id, project_id, kind, status, blueprint_version_id,
        document_revision_id, inputs, backend)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.kind,
    input.blueprint_version_id ?? null,
    input.document_revision_id ?? null,
    input.inputs,
    input.backend,
  );
  return getGeneration(db, id);
}

export function updateGenerationStatus(
  db: DatabaseSync,
  input: {
    id: string;
    status: GenerationStatus;
    backend_job_id?: string | null;
    output_asset_id?: string | null;
    error?: string | null;
  },
): GenerationRecord {
  getGeneration(db, input.id);
  db.prepare(
    `UPDATE generation_records
        SET status = ?, updated_at = datetime('now'),
            backend_job_id = COALESCE(?, backend_job_id),
            output_asset_id = COALESCE(?, output_asset_id),
            error = CASE WHEN ? THEN ? ELSE error END
      WHERE id = ?`,
  ).run(
    input.status,
    input.backend_job_id ?? null,
    input.output_asset_id ?? null,
    Object.hasOwn(input, "error") ? 1 : 0,
    input.error ?? null,
    input.id,
  );
  return getGeneration(db, input.id);
}

export function listGenerations(
  db: DatabaseSync,
  projectId: string,
): GenerationRecord[] {
  return db
    .prepare(
      `SELECT ${cols} FROM generation_records
        WHERE project_id = ? ORDER BY created_at DESC`,
    )
    .all(projectId) as unknown as GenerationRecord[];
}
