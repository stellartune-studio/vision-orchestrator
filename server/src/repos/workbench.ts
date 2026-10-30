import type { DatabaseSync } from "node:sqlite";
import {
  WORKBENCH_BACKDROPS,
  type WorkbenchBackground,
} from "@vo/shared";
import { BadRequestError, ConflictError } from "./errors.ts";

interface WorkbenchRow {
  backdrop_key: string;
  backdrop_locked: number;
  workbench_version: number;
  updated_at: string;
}

function toBackground(row: WorkbenchRow): WorkbenchBackground {
  return {
    backdrop_key: row.backdrop_key as WorkbenchBackground["backdrop_key"],
    locked: row.backdrop_locked === 1,
    workbench_version: row.workbench_version,
    updated_at: row.updated_at,
  };
}

function findWorkbenchRow(
  db: DatabaseSync,
  projectId: string,
): WorkbenchRow | undefined {
  return db
    .prepare(
      `SELECT backdrop_key, backdrop_locked, workbench_version, updated_at
         FROM project_workbench WHERE project_id = ?`,
    )
    .get(projectId) as WorkbenchRow | undefined;
}

export function getWorkbenchBackground(
  db: DatabaseSync,
  projectId: string,
): WorkbenchBackground | null {
  const row = findWorkbenchRow(db, projectId);
  return row?.backdrop_key ? toBackground(row) : null;
}

/**
 * Persist a work's backdrop selection and pin. A settings write —
 * no revision chain, no LLM or generation side effect — guarded by
 * `expected_version` so a stale screen cannot overwrite a newer
 * setting: mismatch → 409, and the caller's draft must be kept.
 */
export function saveWorkbenchBackground(
  db: DatabaseSync,
  input: {
    project_id: string;
    backdrop_key: string;
    locked: boolean;
    expected_version: number | null;
  },
): WorkbenchBackground {
  if (!(WORKBENCH_BACKDROPS as readonly string[]).includes(input.backdrop_key)) {
    throw new BadRequestError("backdrop_key is not a known workbench preset");
  }
  const row = findWorkbenchRow(db, input.project_id);
  if ((row?.workbench_version ?? null) !== input.expected_version) {
    throw new ConflictError("workbench settings changed elsewhere");
  }
  if (row) {
    db.prepare(
      `UPDATE project_workbench
         SET backdrop_key = ?, backdrop_locked = ?,
             workbench_version = workbench_version + 1,
             updated_at = datetime('now')
       WHERE project_id = ?`,
    ).run(input.backdrop_key, input.locked ? 1 : 0, input.project_id);
  } else {
    db.prepare(
      `INSERT INTO project_workbench
         (project_id, backdrop_key, backdrop_locked, workbench_version)
       VALUES (?, ?, ?, 1)`,
    ).run(input.project_id, input.backdrop_key, input.locked ? 1 : 0);
  }
  return getWorkbenchBackground(db, input.project_id)!;
}
