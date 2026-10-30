import type { DatabaseSync } from "node:sqlite";
import type { SavedWorkflowSelection, WorkflowSelection } from "@vo/shared";
import { ConflictError } from "./errors.ts";
import { getProject } from "./projects.ts";

export function getGenerationSelection(db: DatabaseSync, projectId: string): SavedWorkflowSelection {
  getProject(db, projectId);
  const row = db.prepare("SELECT version, selection FROM project_generation_selection WHERE project_id = ?")
    .get(projectId) as { version: number; selection: string | null } | undefined;
  return row ? { version: row.version, selection: row.selection ? JSON.parse(row.selection) : null } : { version: 0, selection: null };
}

export function saveGenerationSelection(db: DatabaseSync, projectId: string, expectedVersion: number, selection: WorkflowSelection | null): SavedWorkflowSelection {
  const current = getGenerationSelection(db, projectId);
  if (current.version !== expectedVersion) throw new ConflictError("Generation selection changed; reload before saving");
  if (current.version === 0) {
    db.prepare("INSERT INTO project_generation_selection(project_id, version, selection) VALUES (?, 1, ?)")
      .run(projectId, selection ? JSON.stringify(selection) : null);
  } else {
    const result = db.prepare("UPDATE project_generation_selection SET version = version + 1, selection = ? WHERE project_id = ? AND version = ?")
      .run(selection ? JSON.stringify(selection) : null, projectId, expectedVersion);
    if (!result.changes) throw new ConflictError("Generation selection changed");
  }
  return getGenerationSelection(db, projectId);
}
