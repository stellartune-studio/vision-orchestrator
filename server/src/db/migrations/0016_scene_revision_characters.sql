-- A scene proposal pins exactly the character revisions chosen for that scene.
CREATE TABLE scene_character_proposals (revision_id TEXT PRIMARY KEY REFERENCES item_revisions(id));
CREATE TRIGGER scene_character_proposals_pending_insert BEFORE INSERT ON scene_character_proposals
WHEN NOT EXISTS (SELECT 1 FROM item_revisions r JOIN design_items i ON i.id = r.item_id
  WHERE r.id = NEW.revision_id AND r.proposal_status = 'pending' AND i.kind = 'story_segment')
BEGIN
  SELECT RAISE(ABORT, 'scene character proposals require a pending scene revision');
END;
CREATE TRIGGER scene_character_proposals_immutable_update BEFORE UPDATE ON scene_character_proposals BEGIN
  SELECT RAISE(ABORT, 'scene character proposals are immutable');
END;
CREATE TRIGGER scene_character_proposals_immutable_delete BEFORE DELETE ON scene_character_proposals BEGIN
  SELECT RAISE(ABORT, 'scene character proposals are immutable');
END;
CREATE TABLE scene_revision_characters (
  revision_id TEXT NOT NULL REFERENCES scene_character_proposals(revision_id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  character_revision_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (revision_id, character_id),
  FOREIGN KEY (character_revision_id, character_id)
    REFERENCES character_revisions(id, character_id)
);
CREATE TRIGGER scene_revision_characters_pending_insert
BEFORE INSERT ON scene_revision_characters
WHEN NOT EXISTS (SELECT 1 FROM item_revisions r JOIN design_items i ON i.id = r.item_id
  WHERE r.id = NEW.revision_id AND r.proposal_status = 'pending' AND i.kind = 'story_segment')
BEGIN
  SELECT RAISE(ABORT, 'scene character assignments require a pending scene revision');
END;
CREATE TRIGGER scene_revision_characters_immutable_update
BEFORE UPDATE ON scene_revision_characters BEGIN
  SELECT RAISE(ABORT, 'scene character assignments are immutable');
END;
CREATE TRIGGER scene_revision_characters_immutable_delete
BEFORE DELETE ON scene_revision_characters BEGIN
  SELECT RAISE(ABORT, 'scene character assignments are immutable');
END;
