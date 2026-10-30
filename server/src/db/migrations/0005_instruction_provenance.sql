-- 0005_instruction_provenance.sql — ownership rules for
-- document_revisions.instruction_message_id.
--
-- NULL stays allowed (pre-provenance rows, hand-written edits, roots).
-- A non-NULL instruction must reference a message that:
--   - exists
--   - belongs to the SAME project as the revision
--   - is a 'user' turn (the directive), never an assistant/system turn
--
-- This is the defense-in-depth layer; the repo performs the same
-- checks so callers get a readable error instead of a trigger abort.
-- Immutability already covers the column via the 0004 update trigger.

CREATE TRIGGER document_revisions_instruction_owner
BEFORE INSERT ON document_revisions
WHEN NEW.instruction_message_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,
    'document_revisions: instruction_message_id must reference a user message of the same project')
  WHERE NOT EXISTS (
    SELECT 1 FROM messages m
     WHERE m.id = NEW.instruction_message_id
       AND m.project_id = NEW.project_id
       AND m.role = 'user');
END;
