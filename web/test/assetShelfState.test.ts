import { test } from "node:test";
import assert from "node:assert/strict";
import type { Asset } from "@vo/shared";
import { findShelfDuplicate, MAX_SHELF_BYTES, shelfFileError } from "../src/features/assetShelfState.ts";

test("shelf restricts extensions and bounded nonempty input", () => {
  assert.equal(shelfFileError("song.WAV", 20), null);
  assert.equal(shelfFileError("clip.mp4", MAX_SHELF_BYTES), null);
  assert.equal(shelfFileError("song.mid", 20), "type");
  assert.equal(shelfFileError("a.png", MAX_SHELF_BYTES + 1), "size");
  assert.equal(shelfFileError("a.png", 0), "size");
});
test("duplicate check only reuses same-project matching hash", () => {
  const a = { id: "a", owner_kind: "project", owner_id: "p", sha256: "abc" } as Asset;
  assert.equal(findShelfDuplicate([a], "p", "ABC")?.id, "a");
  assert.equal(findShelfDuplicate([a], "other", "abc"), undefined);
  assert.equal(findShelfDuplicate([a], "p", "different"), undefined);
});
