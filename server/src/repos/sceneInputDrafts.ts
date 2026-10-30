import { DatabaseSync } from "node:sqlite";
import type {
  SceneInputDraft,
  SceneInputDraftRecord,
  SceneInputDraftSummary,
} from "@vo/shared";
import { newId } from "../domain/ids.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { getProject } from "./projects.ts";

const summaryCols =
  "id, project_id, blueprint_version_id, document_id, " +
  "document_revision_id, saved_at, payload_version, builder_version, digest";

export function listSceneInputDrafts(
  db: DatabaseSync,
  projectId: string,
): SceneInputDraftSummary[] {
  getProject(db, projectId);
  return db
    .prepare(
      `SELECT ${summaryCols} FROM scene_input_drafts
        WHERE project_id = ? ORDER BY saved_at DESC, id DESC`,
    )
    .all(projectId) as unknown as SceneInputDraftSummary[];
}

export function getSceneInputDraft(
  db: DatabaseSync,
  projectId: string,
  id: string,
): SceneInputDraftRecord {
  const row = db
    .prepare(
      `SELECT ${summaryCols}, snapshot FROM scene_input_drafts
        WHERE project_id = ? AND id = ?`,
    )
    .get(projectId, id) as
    | (SceneInputDraftSummary & { snapshot: string })
    | undefined;
  if (!row) throw new NotFoundError("saved scene input draft not found");
  return { ...row, snapshot: JSON.parse(row.snapshot) as SceneInputDraft };
}

/** Validate the request's structural references inside the same
 * transaction that verifies and inserts the snapshot. */
export function validateSceneInputDraftTarget(
  db: DatabaseSync,
  input: {
    project_id: string;
    blueprint_version_id: string;
    document_id: string;
    document_revision_id: string;
  },
): { adopted_revision_id: string | null; revision_blueprint_version_id: string | null } {
  const row = db
    .prepare(
      `SELECT d.adopted_revision_id,
              dr.blueprint_version_id AS revision_blueprint_version_id
         FROM projects p
         JOIN blueprint_versions bv
           ON bv.id = ? AND bv.project_id = p.id
         JOIN production_documents d
           ON d.id = ? AND d.project_id = p.id
         JOIN document_revisions dr
           ON dr.id = ? AND dr.document_id = d.id AND dr.project_id = p.id
        WHERE p.id = ?`,
    )
    .get(
      input.blueprint_version_id,
      input.document_id,
      input.document_revision_id,
      input.project_id,
    ) as
    | { adopted_revision_id: string | null; revision_blueprint_version_id: string | null }
    | undefined;
  if (!row) {
    throw new BadRequestError(
      "project, blueprint version, document, and revision must belong to the same project",
    );
  }
  if (row.revision_blueprint_version_id !== input.blueprint_version_id) {
    throw new BadRequestError("document revision is not derived from this blueprint version");
  }
  return row;
}

export function insertSceneInputDraft(
  db: DatabaseSync,
  input: {
    project_id: string;
    blueprint_version_id: string;
    document_id: string;
    document_revision_id: string;
    payload_version: number;
    builder_version: number;
    digest: string;
    snapshot: SceneInputDraft;
  },
): SceneInputDraftRecord {
  const id = newId();
  db.prepare(
    `INSERT INTO scene_input_drafts
       (id, project_id, blueprint_version_id, document_id,
        document_revision_id, payload_version, builder_version, digest, snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, blueprint_version_id, document_id,
                  document_revision_id, builder_version, digest) DO NOTHING`,
  ).run(
    id,
    input.project_id,
    input.blueprint_version_id,
    input.document_id,
    input.document_revision_id,
    input.payload_version,
    input.builder_version,
    input.digest,
    JSON.stringify(input.snapshot),
  );
  const result = db
    .prepare(
      `SELECT id FROM scene_input_drafts
        WHERE project_id = ? AND blueprint_version_id = ? AND document_id = ?
          AND document_revision_id = ? AND builder_version = ? AND digest = ?`,
    )
    .get(
      input.project_id,
      input.blueprint_version_id,
      input.document_id,
      input.document_revision_id,
      input.builder_version,
      input.digest,
    ) as { id: string } | undefined;
  if (!result) throw new Error("saved scene input draft insert was not visible");
  return getSceneInputDraft(db, input.project_id, result.id);
}
