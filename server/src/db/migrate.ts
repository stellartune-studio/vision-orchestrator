import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Numbered SQL migrations. Applied files are immutable: a file that
 * fails mid-apply rolls back inside its own transaction and the
 * database is left at the last good version — never deleted or
 * reinitialized.
 */
export function migrate(db: DatabaseSync, migrationsDir: string): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  const applied = new Set(
    (
      db.prepare("SELECT version FROM schema_migrations").all() as {
        version: number;
      }[]
    ).map((r) => r.version),
  );

  const newlyApplied: number[] = [];
  for (const file of files) {
    const version = parseInt(file.slice(0, 4), 10);
    if (applied.has(version)) {
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    applyMigrationSql(db, file, version, sql);
    newlyApplied.push(version);
  }
  return newlyApplied;
}

/**
 * Run one migration file inside its transaction.
 *
 * foreign_keys is switched OFF for the transaction and restored after:
 * an in-place table rebuild (new CHECK constraint, column change) needs
 * DROP/rebuild and the pragma cannot be toggled inside a transaction.
 * foreign_key_check runs before COMMIT so a migration that would leave
 * dangling references still fails atomically.
 */
function applyMigrationSql(
  db: DatabaseSync,
  name: string,
  version: number,
  sql: string,
): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(sql);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `migration ${name} leaves ${violations.length} foreign-key violations`,
      );
    }
    db.prepare(
      "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
    ).run(version, name);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw new Error(
      `migration ${name} failed (rolled back; db left at last good version): ${err}`,
    );
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Test helper: apply one explicit migration file. */
export function migrateFile(
  db: DatabaseSync,
  path: string,
  name: string,
): void {
  const version = parseInt(name.slice(0, 4), 10);
  const sql = readFileSync(path, "utf8");
  applyMigrationSql(db, name, version, sql);
}
