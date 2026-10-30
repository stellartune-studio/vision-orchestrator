CREATE TABLE animation_shot_cast (
  revision_id TEXT PRIMARY KEY REFERENCES item_revisions(id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  character_revision_id TEXT NOT NULL,
  FOREIGN KEY (character_revision_id, character_id) REFERENCES character_revisions(id, character_id)
);
CREATE TRIGGER animation_shot_cast_pending BEFORE INSERT ON animation_shot_cast
WHEN NOT EXISTS (SELECT 1 FROM item_revisions r JOIN design_items i ON i.id = r.item_id WHERE r.id = NEW.revision_id AND r.proposal_status = 'pending' AND i.kind = 'shot')
BEGIN SELECT RAISE(ABORT, 'animation cast requires a pending shot'); END;
CREATE TRIGGER animation_shot_cast_no_update BEFORE UPDATE ON animation_shot_cast
BEGIN SELECT RAISE(ABORT, 'animation cast is immutable'); END;
CREATE TRIGGER animation_shot_cast_no_delete BEFORE DELETE ON animation_shot_cast
BEGIN SELECT RAISE(ABORT, 'animation cast is immutable'); END;
