import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlueprintVersionDetail, ProjectState } from "@vo/shared";
import { hasFrozenImageReference } from "../src/features/qwenReferenceSize.ts";

test("Qwen size confirmation is required for a frozen image or character reference", () => {
  const detail = { characters: [], assets: [{ asset_id: "image" }] } as unknown as BlueprintVersionDetail;
  const assets = [{ id: "image", mime: "image/png" }, { id: "text", mime: "text/plain" }] as ProjectState["assets"];
  assert.equal(hasFrozenImageReference(detail, assets), true);
  assert.equal(hasFrozenImageReference({ ...detail, assets: [{ asset_id: "text" } as never] }, assets), false);
  assert.equal(hasFrozenImageReference({ ...detail, assets: [], characters: [{ base_image_asset_id: "character-image" } as never] }, assets), true);
  assert.equal(hasFrozenImageReference(null, assets), false);
});
