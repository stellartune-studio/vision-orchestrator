import { DatabaseSync } from "node:sqlite";
import type {
  SceneDraftReviewStatus,
  SceneInputDraftResumeTarget,
} from "@vo/shared";

export interface SceneInputDraftReviewRow {
  project_id: string;
  draft_id: string;
  version: number;
  state_json: string;
  resume_draft_id: string | null;
  resume_issue_id: string | null;
  updated_at: string;
}

export function getSceneInputDraftReviewRow(
  db: DatabaseSync,
  projectId: string,
  draftId: string,
): SceneInputDraftReviewRow | undefined {
  return db
    .prepare(
      `SELECT project_id, draft_id, version, state_json,
              resume_draft_id, resume_issue_id, updated_at
         FROM scene_input_draft_reviews
        WHERE project_id = ? AND draft_id = ?`,
    )
    .get(projectId, draftId) as SceneInputDraftReviewRow | undefined;
}

export function insertSceneInputDraftReview(
  db: DatabaseSync,
  input: {
    project_id: string;
    draft_id: string;
    state_json: string;
    resume_target: SceneInputDraftResumeTarget | null;
  },
): void {
  db.prepare(
    `INSERT INTO scene_input_draft_reviews
       (project_id, draft_id, version, state_json, resume_draft_id, resume_issue_id)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(
    input.project_id,
    input.draft_id,
    input.state_json,
    input.resume_target?.draft_id ?? null,
    input.resume_target?.issue_id ?? null,
  );
}

export function updateSceneInputDraftReview(
  db: DatabaseSync,
  input: {
    project_id: string;
    draft_id: string;
    expected_version: number;
    state_json: string;
    resume_target: SceneInputDraftResumeTarget | null;
  },
): boolean {
  const result = db
    .prepare(
      `UPDATE scene_input_draft_reviews
          SET version = version + 1,
              state_json = ?,
              resume_draft_id = ?,
              resume_issue_id = ?,
              updated_at = datetime('now')
        WHERE project_id = ? AND draft_id = ? AND version = ?`,
    )
    .run(
      input.state_json,
      input.resume_target?.draft_id ?? null,
      input.resume_target?.issue_id ?? null,
      input.project_id,
      input.draft_id,
      input.expected_version,
    );
  return Number(result.changes) === 1;
}
