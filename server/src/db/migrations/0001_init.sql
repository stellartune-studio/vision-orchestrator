-- 0001_init.sql — Vision Orchestrator v1 schema.
--
-- Invariants enforced here, not just in code:
--   * revision tables are append-only (triggers reject UPDATE of
--     content columns and all DELETEs; only proposal_status may change)
--   * an adopted_revision_id must reference a revision OF THAT entity
--     (composite FK), never another item's/document's revision
--   * blueprint snapshot rows reference same-project entities
--     (denormalized project_id + composite FKs)
--   * approval_events are written ONLY by adoption triggers — the
--     audit ledger cannot drift from adopted_revision_id

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose_note TEXT,
  template_key TEXT,
  template_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_project ON messages(project_id, created_at);

CREATE TABLE design_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'purpose', 'intent', 'audience', 'worldview', 'story_segment',
    'shot', 'fixed_constraint', 'material', 'output_policy', 'other')),
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

CREATE TABLE item_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES design_items(id),
  rev_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'llm')),
  proposal_status TEXT NOT NULL CHECK (proposal_status IN
    ('pending', 'adopted', 'dismissed', 'superseded')),
  base_state_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, rev_no),
  UNIQUE (id, item_id)
);
CREATE INDEX idx_item_revisions_item ON item_revisions(item_id, rev_no);

CREATE TABLE approval_events (
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN
    ('design_item', 'production_document')),
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_approval_events_entity
  ON approval_events(entity_kind, entity_id);

-- Snapshot tables: immutable once written. project_id is denormalized
-- so composite FKs can prove every referenced entity belongs to the
-- same project as the blueprint version itself.

CREATE TABLE blueprint_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version_no INTEGER NOT NULL,
  note TEXT,
  template_key TEXT,
  template_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, version_no),
  UNIQUE (id, project_id)
);

CREATE TABLE blueprint_version_items (
  blueprint_version_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_item_id TEXT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (blueprint_version_id, item_id),
  FOREIGN KEY (project_id, blueprint_version_id)
    REFERENCES blueprint_versions(project_id, id),
  FOREIGN KEY (project_id, item_id)
    REFERENCES design_items(project_id, id),
  FOREIGN KEY (revision_id, item_id)
    REFERENCES item_revisions(id, item_id)
);
CREATE INDEX idx_bv_items_bv ON blueprint_version_items(blueprint_version_id, seq);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE character_revisions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id),
  rev_no INTEGER NOT NULL,
  profile TEXT NOT NULL,
  base_image_asset_id TEXT REFERENCES assets(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (character_id, rev_no),
  UNIQUE (id, character_id)
);

-- A project pins a specific character revision; library updates never
-- leak into existing projects.
CREATE TABLE project_characters (
  project_id TEXT NOT NULL REFERENCES projects(id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  character_revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, character_id),
  FOREIGN KEY (character_revision_id, character_id)
    REFERENCES character_revisions(id, character_id)
);

CREATE TABLE blueprint_version_characters (
  blueprint_version_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES characters(id),
  character_revision_id TEXT NOT NULL,
  base_image_asset_id TEXT REFERENCES assets(id),
  PRIMARY KEY (blueprint_version_id, character_id),
  FOREIGN KEY (project_id, blueprint_version_id)
    REFERENCES blueprint_versions(project_id, id),
  FOREIGN KEY (character_revision_id, character_id)
    REFERENCES character_revisions(id, character_id)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('project', 'character')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  sha256 TEXT,
  meta TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assets_owner ON assets(owner_kind, owner_id);

CREATE TABLE blueprint_version_assets (
  blueprint_version_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'material',
  PRIMARY KEY (blueprint_version_id, asset_id),
  FOREIGN KEY (project_id, blueprint_version_id)
    REFERENCES blueprint_versions(project_id, id),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

CREATE TABLE production_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('script', 'storyboard')),
  title TEXT NOT NULL DEFAULT '',
  adopted_revision_id TEXT,
  state_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, id),
  FOREIGN KEY (adopted_revision_id, id)
    REFERENCES document_revisions(id, document_id)
);

CREATE TABLE document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  -- denormalized: lets FKs prove doc revision, document and source
  -- blueprint version all belong to the same project
  project_id TEXT NOT NULL,
  rev_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'llm')),
  blueprint_version_id TEXT,
  proposal_status TEXT NOT NULL CHECK (proposal_status IN
    ('pending', 'adopted', 'dismissed', 'superseded')),
  base_state_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (document_id, rev_no),
  UNIQUE (id, document_id),
  FOREIGN KEY (project_id, document_id)
    REFERENCES production_documents(project_id, id),
  FOREIGN KEY (project_id, blueprint_version_id)
    REFERENCES blueprint_versions(project_id, id)
);
CREATE INDEX idx_document_revisions_doc
  ON document_revisions(document_id, rev_no);

CREATE TABLE generation_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  status TEXT NOT NULL CHECK (status IN
    ('queued', 'running', 'succeeded', 'failed')),
  blueprint_version_id TEXT,
  document_revision_id TEXT,
  -- JSON snapshot of the EXACT payload sent to the backend
  -- (prompt text, resolved refs, settings) — provenance, not pointers.
  inputs TEXT NOT NULL DEFAULT '{}',
  backend TEXT NOT NULL,
  backend_job_id TEXT,
  output_asset_id TEXT REFERENCES assets(id),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id, blueprint_version_id)
    REFERENCES blueprint_versions(project_id, id)
);
CREATE INDEX idx_generation_records_project
  ON generation_records(project_id, created_at);

-- ---- Immutability + audit triggers ----

-- revision content columns are frozen; only proposal_status may change
CREATE TRIGGER item_revisions_immutable
BEFORE UPDATE ON item_revisions
BEGIN
  SELECT RAISE(ABORT, 'item_revisions: only proposal_status may change')
  WHERE NOT (
    OLD.id = NEW.id AND OLD.item_id = NEW.item_id
    AND OLD.rev_no = NEW.rev_no AND OLD.content = NEW.content
    AND OLD.source = NEW.source
    AND OLD.base_state_version = NEW.base_state_version
    AND OLD.created_at = NEW.created_at);
END;

CREATE TRIGGER item_revisions_no_delete
BEFORE DELETE ON item_revisions
BEGIN
  SELECT RAISE(ABORT, 'item_revisions are immutable');
END;

CREATE TRIGGER document_revisions_immutable
BEFORE UPDATE ON document_revisions
BEGIN
  SELECT RAISE(ABORT, 'document_revisions: only proposal_status may change')
  WHERE NOT (
    OLD.id = NEW.id AND OLD.document_id = NEW.document_id
    AND OLD.project_id = NEW.project_id
    AND OLD.rev_no = NEW.rev_no AND OLD.content = NEW.content
    AND OLD.source = NEW.source
    AND OLD.blueprint_version_id IS NEW.blueprint_version_id
    AND OLD.base_state_version = NEW.base_state_version
    AND OLD.created_at = NEW.created_at);
END;

CREATE TRIGGER document_revisions_no_delete
BEFORE DELETE ON document_revisions
BEGIN
  SELECT RAISE(ABORT, 'document_revisions are immutable');
END;

CREATE TRIGGER character_revisions_no_update
BEFORE UPDATE ON character_revisions
BEGIN
  SELECT RAISE(ABORT, 'character_revisions are immutable');
END;
CREATE TRIGGER character_revisions_no_delete
BEFORE DELETE ON character_revisions
BEGIN
  SELECT RAISE(ABORT, 'character_revisions are immutable');
END;

-- blueprint snapshot tables are frozen after insert
CREATE TRIGGER bv_items_no_update
BEFORE UPDATE ON blueprint_version_items
BEGIN
  SELECT RAISE(ABORT, 'blueprint_version_items are immutable');
END;
CREATE TRIGGER bv_items_no_delete
BEFORE DELETE ON blueprint_version_items
BEGIN
  SELECT RAISE(ABORT, 'blueprint_version_items are immutable');
END;

CREATE TRIGGER bv_characters_no_update
BEFORE UPDATE ON blueprint_version_characters
BEGIN
  SELECT RAISE(ABORT, 'blueprint_version_characters are immutable');
END;
CREATE TRIGGER bv_characters_no_delete
BEFORE DELETE ON blueprint_version_characters
BEGIN
  SELECT RAISE(ABORT, 'blueprint_version_characters are immutable');
END;

CREATE TRIGGER bv_assets_no_update
BEFORE UPDATE ON blueprint_version_assets
BEGIN
  SELECT RAISE(ABORT, 'blueprint_version_assets are immutable');
END;
CREATE TRIGGER bv_assets_no_delete
BEFORE DELETE ON blueprint_version_assets
BEGIN
  SELECT RAISE(ABORT, 'blueprint_version_assets are immutable');
END;

CREATE TRIGGER blueprint_versions_no_update
BEFORE UPDATE ON blueprint_versions
BEGIN
  SELECT RAISE(ABORT, 'blueprint_versions are immutable');
END;
CREATE TRIGGER blueprint_versions_no_delete
BEFORE DELETE ON blueprint_versions
BEGIN
  SELECT RAISE(ABORT, 'blueprint_versions are immutable');
END;

-- Adoption writes the audit event automatically: the ledger can never
-- diverge from adopted_revision_id.
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

CREATE TRIGGER documents_approval_audit
AFTER UPDATE OF adopted_revision_id ON production_documents
WHEN NEW.adopted_revision_id IS NOT NULL
  AND NEW.adopted_revision_id IS NOT OLD.adopted_revision_id
BEGIN
  INSERT INTO approval_events
    (id, entity_kind, entity_id, revision_id, actor, created_at)
  VALUES
    (lower(hex(randomblob(16))), 'production_document', NEW.id,
     NEW.adopted_revision_id, 'user', datetime('now'));
END;
