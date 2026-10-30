-- Mutable director review progress for an immutable saved scene input draft.
-- Item identities are derived from the draft id plus a JSON Pointer into its snapshot.
CREATE UNIQUE INDEX idx_scene_input_drafts_project_pair
  ON scene_input_drafts(project_id, id);

CREATE TABLE scene_input_draft_reviews (
  project_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  resume_draft_id TEXT,
  resume_issue_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, draft_id),
  FOREIGN KEY (project_id, draft_id)
    REFERENCES scene_input_drafts(project_id, id),
  FOREIGN KEY (project_id, resume_draft_id)
    REFERENCES scene_input_drafts(project_id, id),
  CHECK ((resume_draft_id IS NULL) = (resume_issue_id IS NULL))
);
