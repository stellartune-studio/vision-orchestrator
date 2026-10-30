-- Add 'camera_work' to design_items.kind CHECK list.
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt in
-- place. The migration runner applies files with foreign_keys OFF and
-- verifies with foreign_key_check before COMMIT — child tables
-- (blueprint_version_items, item_revisions, self-references) resolve to
-- the rebuilt table by name. The approval-audit trigger is re-created
-- verbatim from 0001_init.sql.
CREATE TABLE design_items_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'purpose', 'intent', 'audience', 'worldview', 'story_segment',
    'shot', 'camera_work', 'fixed_constraint', 'material',
    'output_policy', 'other')),
  seq INTEGER NOT NULL DEFAULT 0,
  parent_item_id TEXT,
  label TEXT NOT NULL,
  adopted_revision_id TEXT,
  state_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, id),
  -- shot -> story_segment link (kind checked in the repo layer)
  FOREIGN KEY (project_id, parent_item_id)
    REFERENCES design_items(project_id, id),
  -- adopted revision must be a revision OF THIS item
  FOREIGN KEY (adopted_revision_id, id)
    REFERENCES item_revisions(id, item_id)
);

INSERT INTO design_items_new
  SELECT id, project_id, kind, seq, parent_item_id, label,
         adopted_revision_id, state_version, created_at
    FROM design_items;

DROP TABLE design_items;
ALTER TABLE design_items_new RENAME TO design_items;

CREATE TRIGGER design_items_approval_audit
AFTER UPDATE OF adopted_revision_id ON design_items
WHEN NEW.adopted_revision_id IS NOT NULL
  AND NEW.adopted_revision_id IS NOT OLD.adopted_revision_id
BEGIN
  INSERT INTO approval_events
    (id, entity_kind, entity_id, revision_id, actor, created_at)
  VALUES
    (lower(hex(randomblob(16))), 'design_item', NEW.id,
     NEW.adopted_revision_id, 'user', datetime('now'));
END;
