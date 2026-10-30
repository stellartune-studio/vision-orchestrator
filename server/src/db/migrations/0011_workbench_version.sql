-- Optimistic-concurrency counter for workbench settings: every
-- settings save bumps it so a stale screen's write is rejected
-- instead of silently overwriting a newer setting.
ALTER TABLE project_workbench
  ADD COLUMN workbench_version INTEGER NOT NULL DEFAULT 1;
