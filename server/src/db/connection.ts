import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open (or create) the SQLite database and enforce connection-level
 * invariants. foreign_keys is OFF by default in SQLite — the schema's
 * composite-FK guarantees are meaningless unless we verify it here.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const fk = db.prepare("PRAGMA foreign_keys").get() as
    | { foreign_keys: number }
    | undefined;
  if (!fk || fk.foreign_keys !== 1) {
    db.close();
    throw new Error("PRAGMA foreign_keys could not be enabled");
  }
  return db;
}

/** Run `fn` inside a transaction. External calls (LLM, generation
 * backends) must never happen inside this wrapper. */
export function transact<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw err;
  }
}
