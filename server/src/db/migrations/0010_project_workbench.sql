-- Per-project shared-workbench settings. Today this is the backdrop
-- selection and its pin; voice/template slots arrive as later columns
-- or rows, keeping this table the single workbench-settings home.
CREATE TABLE project_workbench (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  backdrop_key TEXT,
  backdrop_locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
