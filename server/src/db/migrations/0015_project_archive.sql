-- Reversible archive: archived works hide from the default library
-- list but keep every row and file untouched (unlike hard delete).
ALTER TABLE projects ADD COLUMN archived_at TEXT;
