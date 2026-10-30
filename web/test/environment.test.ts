import { test } from "node:test";
import assert from "node:assert/strict";
import { inputChoices } from "../src/api/environment.ts";

test("model menus accept legacy and current Comfy V3 combo schemas", () => {
  assert.deepEqual(inputChoices([["model-a.gguf", "model-b.gguf"]]), ["model-a.gguf", "model-b.gguf"]);
  assert.deepEqual(inputChoices(["COMBO", { options: ["style.safetensors", "other.safetensors"] }]), ["style.safetensors", "other.safetensors"]);
  assert.deepEqual(inputChoices(["STRING", { default: "" }]), []);
  assert.deepEqual(inputChoices(undefined), []);
  assert.deepEqual(inputChoices(["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "on", inputs: {} }, { key: "off", inputs: {} }] }]), ["on", "off"]);
});
