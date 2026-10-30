-- 0003_message_seq_unique.sql — enforce message ordering key.
--
-- 0002 added seq (per-project monotonic order); this upgrades the
-- index to UNIQUE so a duplicate seq can never be written even by a
-- future code path that forgets the MAX(seq)+1 convention.
-- (SQLite serializes writers, so concurrent inserts cannot race the
-- MAX+1 subquery; the constraint guards against bugs, not races.)

DROP INDEX IF EXISTS idx_messages_project_seq;
CREATE UNIQUE INDEX idx_messages_project_seq
  ON messages(project_id, seq);
