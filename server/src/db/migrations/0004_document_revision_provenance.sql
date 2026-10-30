-- 0004_document_revision_provenance.sql — persistent provenance for
-- document revisions: which revision they were edited from and which
-- chat instruction produced them (LLM amendments).
--
-- Both columns are nullable: pre-existing rows keep NULL — unknown
-- bases are never guessed or backfilled.

ALTER TABLE document_revisions ADD COLUMN base_revision_id TEXT;
ALTER TABLE document_revisions ADD COLUMN instruction_message_id TEXT
  REFERENCES messages(id);

-- A declared base must be a revision of the SAME document — composite
-- FK can't be added via ALTER TABLE, so the insert trigger enforces
-- the ownership rule at the database level.
CREATE TRIGGER document_revisions_base_same_doc
BEFORE INSERT ON document_revisions
WHEN NEW.base_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,
    'document_revisions: base_revision_id must reference a revision of the same document')
  WHERE NOT EXISTS (
    SELECT 1 FROM document_revisions b
     WHERE b.id = NEW.base_revision_id
       AND b.document_id = NEW.document_id);
END;

-- Extend the immutability rule to the new columns: provenance is
-- written at insert and may never be rewritten afterwards.
DROP TRIGGER document_revisions_immutable;
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
    AND OLD.base_revision_id IS NEW.base_revision_id
    AND OLD.instruction_message_id IS NEW.instruction_message_id
    AND OLD.base_state_version = NEW.base_state_version
    AND OLD.created_at = NEW.created_at);
END;
