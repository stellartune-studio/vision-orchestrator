CREATE TABLE animation_background_plans (
  revision_id TEXT PRIMARY KEY REFERENCES item_revisions(id),
  background_asset_id TEXT NOT NULL REFERENCES assets(id),
  background_sha256 TEXT NOT NULL,
  foreground_asset_id TEXT NOT NULL REFERENCES assets(id),
  foreground_sha256 TEXT NOT NULL
);
CREATE TRIGGER animation_background_pending_insert BEFORE INSERT ON animation_background_plans
WHEN NOT EXISTS (SELECT 1 FROM item_revisions r JOIN design_items i ON i.id = r.item_id WHERE r.id = NEW.revision_id AND r.proposal_status = 'pending' AND i.kind = 'shot')
BEGIN SELECT RAISE(ABORT, 'animation background requires a pending shot revision'); END;
CREATE TRIGGER animation_background_immutable_update BEFORE UPDATE ON animation_background_plans BEGIN SELECT RAISE(ABORT, 'animation background is immutable'); END;
CREATE TRIGGER animation_background_immutable_delete BEFORE DELETE ON animation_background_plans BEGIN SELECT RAISE(ABORT, 'animation background is immutable'); END;
