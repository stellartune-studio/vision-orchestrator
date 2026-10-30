ALTER TABLE mv_plans ADD COLUMN beat_origin TEXT NOT NULL DEFAULT 'manual' CHECK (beat_origin IN ('manual', 'estimated_selected', 'estimated_edited'));
