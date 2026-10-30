CREATE TABLE animation_composite_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES design_items(id),
  blueprint_version_id TEXT NOT NULL REFERENCES blueprint_versions(id),
  status TEXT NOT NULL CHECK(status IN ('running', 'cancelling', 'succeeded', 'failed', 'cancelled')),
  asset_id TEXT REFERENCES assets(id),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX animation_composite_one_active_shot ON animation_composite_jobs(shot_id) WHERE status IN ('running', 'cancelling');
