CREATE TABLE project_comparison (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  ids_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0)
);
