-- 0002_message_seq.sql — deterministic message ordering.
--
-- created_at has one-second precision, so same-second rows used to
-- tie-break on the random UUID id and could render out of order.
-- seq is a per-project monotonic insertion counter (assigned like
-- rev_no); backfill from rowid preserves the original insertion order
-- of pre-existing rows.

ALTER TABLE messages ADD COLUMN seq INTEGER;
UPDATE messages SET seq = rowid;
CREATE INDEX idx_messages_project_seq ON messages(project_id, seq);
