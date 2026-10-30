CREATE TABLE poster_plans (
 revision_id TEXT PRIMARY KEY REFERENCES document_revisions(id),
 still_asset_id TEXT NOT NULL REFERENCES assets(id),
 still_sha256 TEXT NOT NULL,
 motion_asset_id TEXT NOT NULL REFERENCES assets(id),
 motion_sha256 TEXT NOT NULL,
 layout_json TEXT NOT NULL
);
CREATE TRIGGER poster_plans_pending BEFORE INSERT ON poster_plans
WHEN NOT EXISTS (SELECT 1 FROM document_revisions WHERE id = NEW.revision_id AND proposal_status = 'pending')
BEGIN SELECT RAISE(ABORT, 'Poster plan requires a pending revision'); END;
CREATE TRIGGER poster_plans_no_update BEFORE UPDATE ON poster_plans
BEGIN SELECT RAISE(ABORT, 'Poster plan is immutable'); END;
CREATE TRIGGER poster_plans_no_delete BEFORE DELETE ON poster_plans
BEGIN SELECT RAISE(ABORT, 'Poster plan is immutable'); END;
