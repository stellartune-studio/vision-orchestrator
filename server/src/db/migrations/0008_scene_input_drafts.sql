-- Saved scene instruction snapshots. The JSON is a frozen copy of the
-- preview the director saw; it is never rebuilt when read.
CREATE TABLE scene_input_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  blueprint_version_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_revision_id TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_version INTEGER NOT NULL CHECK (payload_version >= 1),
  builder_version INTEGER NOT NULL CHECK (builder_version >= 1),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  UNIQUE (
    project_id, blueprint_version_id, document_id,
    document_revision_id, builder_version, digest
  ),
  FOREIGN KEY (blueprint_version_id, project_id)
    REFERENCES blueprint_versions(id, project_id),
  FOREIGN KEY (project_id, document_id)
    REFERENCES production_documents(project_id, id),
  FOREIGN KEY (document_revision_id, document_id)
    REFERENCES document_revisions(id, document_id)
);
CREATE INDEX idx_scene_input_drafts_project
  ON scene_input_drafts(project_id, saved_at DESC, id DESC);

CREATE TRIGGER scene_input_drafts_no_update
BEFORE UPDATE ON scene_input_drafts
BEGIN
  SELECT RAISE(ABORT, 'scene input draft snapshots are immutable');
END;

CREATE TRIGGER scene_input_drafts_no_delete
BEFORE DELETE ON scene_input_drafts
BEGIN
  SELECT RAISE(ABORT, 'scene input draft snapshots are immutable');
END;
