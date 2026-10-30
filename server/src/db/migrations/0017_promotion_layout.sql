CREATE TABLE promotion_layouts (
  revision_id TEXT PRIMARY KEY REFERENCES document_revisions(id),
  logo_asset_id TEXT NOT NULL REFERENCES assets(id),
  logo_sha256 TEXT NOT NULL,
  title TEXT NOT NULL,
  layout_json TEXT NOT NULL
);
CREATE TRIGGER promotion_layout_pending BEFORE INSERT ON promotion_layouts
WHEN NOT EXISTS (SELECT 1 FROM document_revisions WHERE id = NEW.revision_id AND proposal_status = 'pending')
BEGIN SELECT RAISE(ABORT, 'promotion layout requires a pending revision'); END;
CREATE TRIGGER promotion_layout_no_update BEFORE UPDATE ON promotion_layouts
BEGIN SELECT RAISE(ABORT, 'promotion layout is immutable'); END;
CREATE TRIGGER promotion_layout_no_delete BEFORE DELETE ON promotion_layouts
BEGIN SELECT RAISE(ABORT, 'promotion layout is immutable'); END;
