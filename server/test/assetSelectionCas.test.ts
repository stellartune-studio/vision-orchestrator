import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openDatabase, transact } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertAsset, setAssetSelected, getAsset } from "../src/repos/assets.ts";
test("asset CAS prevents stale/ABA changes and preserves the selected state", () => {
 const db = openDatabase(":memory:");
 try {
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const p = transact(db, () => createProject(db, "fixture"));
  const a = insertAsset(db, { owner_kind: "project", owner_id: p.id, kind: "image", path: "fixture.png" });
  assert.equal(a.selection_version, 0);
  assert.equal(setAssetSelected(db, a.id, true, 0).selection_version, 1);
  assert.throws(() => setAssetSelected(db, a.id, false, 0), /selection changed/);
  assert.equal(getAsset(db, a.id).selected, 1);
  setAssetSelected(db, a.id, false, 1);
  assert.throws(() => setAssetSelected(db, a.id, true, 0), /selection changed/);
 } finally { db.close(); }
});
