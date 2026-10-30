import assert from "node:assert/strict";
import { test } from "node:test";
import { compareStorageKey, parseCompareSelection } from "../src/features/compareSelection.ts";

test("comparison persistence keeps only valid independent pairs", () => {
  assert.deepEqual(parseCompareSelection('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseCompareSelection('[]'), []);
  for (const invalid of ['["a","a"]', '["a","b","c"]', '[1]', 'not json']) assert.equal(parseCompareSelection(invalid), null);
  assert.notEqual(compareStorageKey("one"), compareStorageKey("two"));
});
