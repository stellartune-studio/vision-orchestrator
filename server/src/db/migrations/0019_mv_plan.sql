CREATE TABLE mv_plans (
  revision_id TEXT PRIMARY KEY REFERENCES document_revisions(id),
  audio_asset_id TEXT NOT NULL REFERENCES assets(id),
  audio_sha256 TEXT NOT NULL,
  audio_duration REAL NOT NULL CHECK (audio_duration > 0),
  beats_json TEXT NOT NULL,
  lyrics_json TEXT NOT NULL
);
CREATE TRIGGER mv_plans_pending BEFORE INSERT ON mv_plans
WHEN NOT EXISTS (SELECT 1 FROM document_revisions WHERE id = NEW.revision_id AND proposal_status = 'pending')
BEGIN SELECT RAISE(ABORT, 'MV plan requires a pending revision'); END;
CREATE TRIGGER mv_plans_no_update BEFORE UPDATE ON mv_plans
BEGIN SELECT RAISE(ABORT, 'MV plan is immutable'); END;
CREATE TRIGGER mv_plans_no_delete BEFORE DELETE ON mv_plans
BEGIN SELECT RAISE(ABORT, 'MV plan is immutable'); END;
