import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkScratchDataDir } from "../../scripts/ui-verify/data-dir-guard.mjs";

// The guard is exercised with an INJECTED dummy "production" dir —
// the real repo data dir is never used for negative tests.
const root = mkdtempSync(join(tmpdir(), "vo-guard-test-"));
const fakeRepo = join(root, "fake-repo");
const prodDir = join(fakeRepo, "data");
mkdirSync(prodDir, { recursive: true });

// Dummy production DB with a real migration-history table.
const dbPath = join(prodDir, "app.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT);",
  );
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run("0001_init", "2026-01-01T00:00:00Z");
  db.close();
}
const sha256 = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const prodDbHash = sha256(dbPath);
const prodListing = readdirSync(prodDir).sort();

const migrationRows = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare("SELECT version, applied_at FROM schema_migrations")
    .all() as { version: string; applied_at: string }[];
  db.close();
  return rows.map((r) => ({ version: r.version, applied_at: r.applied_at }));
};

const assertProdUntouched = (label: string) => {
  assert.equal(sha256(dbPath), prodDbHash, `${label}: db file changed`);
  assert.deepEqual(
    readdirSync(prodDir).sort(),
    prodListing,
    `${label}: data dir listing changed`,
  );
  assert.deepEqual(
    migrationRows(),
    [{ version: "0001_init", applied_at: "2026-01-01T00:00:00Z" }],
    `${label}: migration history changed`,
  );
};

test("guard refuses an unset VO_DATA_DIR", () => {
  const r = checkScratchDataDir(undefined, prodDir);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /required/);
  assertProdUntouched("unset");
});

test("guard refuses an empty/blank VO_DATA_DIR", () => {
  for (const v of ["", "   "]) {
    const r = checkScratchDataDir(v, prodDir);
    assert.equal(r.ok, false, JSON.stringify(v));
  }
  assertProdUntouched("blank");
});

test("guard refuses the production data dir itself", () => {
  const r = checkScratchDataDir(prodDir, prodDir);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /production data dir/);
  assertProdUntouched("prod path");
});

test("guard refuses an alias (junction/symlink) to the production dir", (t) => {
  const link = join(root, "alias-to-data");
  try {
    // "junction" works on Windows without elevated rights; on POSIX
    // fall back to a directory symlink.
    symlinkSync(prodDir, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    t.skip(`cannot create dir link on this environment: ${String(e)}`);
    return;
  }
  const r = checkScratchDataDir(link, prodDir);
  assert.equal(r.ok, false);
  assertProdUntouched("alias");
});

test("guard accepts an explicit scratch dir elsewhere", () => {
  const scratch = join(root, "scratch-data");
  const r = checkScratchDataDir(scratch, prodDir);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.dataDir, /scratch-data$/);
});

test("guard accepts a different dir that merely shares the name", () => {
  // .../other/data is not the prod dir even though the basename matches.
  const other = join(root, "other");
  mkdirSync(join(other, "data"), { recursive: true });
  const r = checkScratchDataDir(join(other, "data"), prodDir);
  assert.equal(r.ok, true);
});
