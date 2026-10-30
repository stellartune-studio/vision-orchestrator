CREATE TABLE project_generation_selection (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  version INTEGER NOT NULL,
  selection TEXT
);
