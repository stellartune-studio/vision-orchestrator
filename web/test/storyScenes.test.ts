import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemView } from "@vo/shared";
import { storyScenes } from "../src/features/storyScenes.ts";

test("story mode presents only scene items in their project order", () => {
  const items = [
    { id: "later", kind: "story_segment", seq: 2 },
    { id: "other", kind: "intent", seq: 0 },
    { id: "first", kind: "story_segment", seq: 1 },
  ] as ItemView[];
  assert.deepEqual(storyScenes(items).map((item) => item.id), ["first", "later"]);
  assert.deepEqual(items.map((item) => item.id), ["later", "other", "first"]);
});
