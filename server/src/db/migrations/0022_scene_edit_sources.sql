CREATE TABLE scene_edit_sources (
  revision_id TEXT PRIMARY KEY REFERENCES item_revisions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  sha256 TEXT NOT NULL
);
CREATE TRIGGER scene_edit_sources_pending_insert BEFORE INSERT ON scene_edit_sources
WHEN NOT EXISTS (SELECT 1 FROM item_revisions r JOIN design_items i ON i.id = r.item_id
  WHERE r.id = NEW.revision_id AND r.proposal_status = 'pending' AND i.kind = 'story_segment')
BEGIN SELECT RAISE(ABORT, 'scene edit source requires a pending scene revision'); END;
CREATE TRIGGER scene_edit_sources_immutable_update BEFORE UPDATE ON scene_edit_sources
BEGIN SELECT RAISE(ABORT, 'scene edit source is immutable'); END;
CREATE TRIGGER scene_edit_sources_immutable_delete BEFORE DELETE ON scene_edit_sources
BEGIN SELECT RAISE(ABORT, 'scene edit source is immutable'); END;
