import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedWorkflowSelection, ServerMeta } from "@vo/shared";
import { storyboardUsesSingleEdit } from "../src/features/storyboardProfile.ts";

test("a custom workflow overrides the bundled edit profile", () => {
  const meta = { gen_profile: "qwen-image-2.1-turbo-edit-single" } as ServerMeta;
  assert.equal(storyboardUsesSingleEdit(meta, null), false);
  assert.equal(storyboardUsesSingleEdit(meta, { version: 0, selection: null }), true);
  assert.equal(storyboardUsesSingleEdit(meta, { version: 1, selection: {} } as SavedWorkflowSelection), false);
});
