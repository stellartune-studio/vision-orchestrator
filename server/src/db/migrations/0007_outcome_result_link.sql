-- Tighten amendment_outcomes: a saved outcome must point at the actual
-- amendment revision produced by THIS directive, not just any revision
-- of the same document. Verified at save time; later adoption moves
-- never retroactively invalidate the record.

CREATE TRIGGER amendment_outcomes_result_shape
BEFORE INSERT ON amendment_outcomes
BEGIN
  -- rejected needs a non-empty reason; reasons may not be carried by
  -- other outcomes.
  SELECT RAISE(ABORT, 'amendment_outcomes: rejected requires a non-empty reject_reason')
  WHERE NEW.outcome = 'rejected'
    AND (NEW.reject_reason IS NULL OR length(trim(NEW.reject_reason)) = 0);

  SELECT RAISE(ABORT, 'amendment_outcomes: reject_reason only belongs to rejected')
  WHERE NEW.outcome <> 'rejected' AND NEW.reject_reason IS NOT NULL;

  -- The outcome's blueprint basis is the base revision's — amendments
  -- inherit the basis of the revision they edit (NULL counts).
  SELECT RAISE(ABORT, 'amendment_outcomes: blueprint_version_id must match the base revision')
  WHERE NOT EXISTS (
    SELECT 1 FROM document_revisions b
    WHERE b.id = NEW.base_revision_id
      AND b.document_id = NEW.document_id
      AND b.blueprint_version_id IS NEW.blueprint_version_id
  );
END;

CREATE TRIGGER amendment_outcomes_result_link
BEFORE INSERT ON amendment_outcomes
WHEN NEW.outcome = 'saved'
BEGIN
  -- Never let the base itself pose as its own amendment.
  SELECT RAISE(ABORT, 'amendment_outcomes: result revision must differ from its base')
  WHERE NEW.result_revision_id = NEW.base_revision_id;

  -- The result must be the llm revision produced by this instruction
  -- on this base with this blueprint basis — a revision with a
  -- different base, different instruction, different source, or a
  -- different blueprint version (NULL-sensitive) is a wrong link.
  SELECT RAISE(ABORT, 'amendment_outcomes: result must be the llm amendment of this base and instruction')
  WHERE NOT EXISTS (
    SELECT 1 FROM document_revisions r
    WHERE r.id = NEW.result_revision_id
      AND r.document_id = NEW.document_id
      AND r.source = 'llm'
      AND r.base_revision_id = NEW.base_revision_id
      AND r.instruction_message_id = NEW.instruction_message_id
      AND r.blueprint_version_id IS NEW.blueprint_version_id
  );
END;
