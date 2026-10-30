-- 0006_amendment_outcomes.sql — durable record of what each revision
-- directive produced, so the save result survives reloads and is never
-- re-derived from message text.
--
-- One row per COMPLETED directive: 'saved' (a pending revision was
-- stored), 'reply_only' (no amendment payload), 'rejected' (the
-- amendment failed validation). Directives that never completed —
-- 409 race, provider failure, pre-record history — have no row and
-- stay "unknown"; the UI must not guess-convert them.
--
-- Belonging is enforced by composite FKs (same project) plus an insert
-- trigger for message roles; rows are immutable once written.

CREATE TABLE amendment_outcomes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  instruction_message_id TEXT NOT NULL REFERENCES messages(id),
  assistant_message_id TEXT NOT NULL REFERENCES messages(id),
  document_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  blueprint_version_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('saved','reply_only','rejected')),
  result_revision_id TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- one directive → one recorded result
  UNIQUE (instruction_message_id),
  CHECK ((outcome = 'saved') = (result_revision_id IS NOT NULL)),
  CHECK (outcome != 'rejected' OR reject_reason IS NOT NULL),
  FOREIGN KEY (project_id, document_id)
    REFERENCES production_documents(project_id, id),
  FOREIGN KEY (base_revision_id, document_id)
    REFERENCES document_revisions(id, document_id),
  FOREIGN KEY (result_revision_id, document_id)
    REFERENCES document_revisions(id, document_id),
  FOREIGN KEY (project_id, blueprint_version_id)
    REFERENCES blueprint_versions(project_id, id)
);
CREATE INDEX idx_amendment_outcomes_project
  ON amendment_outcomes(project_id, created_at);

-- messages lack a composite unique key, so role + same-project rules
-- live in a trigger — same defense-in-depth shape as migration 0005.
CREATE TRIGGER amendment_outcomes_message_owner
BEFORE INSERT ON amendment_outcomes
BEGIN
  SELECT RAISE(ABORT,
    'amendment_outcomes: instruction must be a user message of the same project')
  WHERE NOT EXISTS (
    SELECT 1 FROM messages m
     WHERE m.id = NEW.instruction_message_id
       AND m.project_id = NEW.project_id
       AND m.role = 'user');
  SELECT RAISE(ABORT,
    'amendment_outcomes: reply must be an assistant message of the same project')
  WHERE NOT EXISTS (
    SELECT 1 FROM messages m
     WHERE m.id = NEW.assistant_message_id
       AND m.project_id = NEW.project_id
       AND m.role = 'assistant');
END;

CREATE TRIGGER amendment_outcomes_immutable
BEFORE UPDATE ON amendment_outcomes
BEGIN
  SELECT RAISE(ABORT, 'amendment_outcomes are immutable');
END;

CREATE TRIGGER amendment_outcomes_no_delete
BEFORE DELETE ON amendment_outcomes
BEGIN
  SELECT RAISE(ABORT, 'amendment_outcomes are immutable');
END;
