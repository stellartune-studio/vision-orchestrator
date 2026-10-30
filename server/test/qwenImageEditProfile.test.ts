import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readQwenWorkflowFile,
  validateQwenWorkflowGraph,
  type ApiGraph,
} from "../src/gen/qwenImageEditProfile.ts";
import { ComfySdkBackend } from "../src/gen/comfySdkBackend.ts";
import type { GenerationInput } from "../src/gen/backend.ts";

const fixture = (): Record<string, unknown> => ({
  prompt: {
    "1": { class_type: "LoadImage", inputs: { image: "synthetic_red_barrier.png" } },
    "2": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_turbo_int8_convrot.safetensors", weight_dtype: "default" } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "6": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "fixture prompt", resolution: 0, negative_prompt: "", "images.image_1": ["1", 0], clip: ["3", 0], vae: ["4", 0] } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: 891836227295375 } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["4", 0] } },
    "13": { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "qwen-smoke" } },
  },
});

test("qwen profile validates required node and field contracts", () => {
  const graph = validateQwenWorkflowGraph(fixture());
  assert.equal(graph["6"].inputs?.["images.image_1"] instanceof Array, true);
  const bad = fixture();
  (((bad.prompt as Record<string, any>)["6"].inputs)["images.image_1"]) = ["2", 0];
  assert.throws(() => validateQwenWorkflowGraph(bad), /not linked from LoadImage/);
  const missing = fixture();
  delete (missing.prompt as Record<string, any>)["13"];
  assert.throws(() => validateQwenWorkflowGraph(missing), /node 13/);
});

test("qwen profile file loader pins bytes and exposes actual model names", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-qwen-profile-"));
  try {
    const file = join(dir, "api.json");
    const raw = JSON.stringify(fixture());
    writeFileSync(file, raw);
    const sha = createHash("sha256").update(raw).digest("hex").toUpperCase();
    const info = readQwenWorkflowFile(file, sha);
    assert.equal(info.sha256, sha);
    assert.deepEqual(info.model_files.map((m) => m.file), [
      "qwen_image_2.1_turbo_int8_convrot.safetensors",
      "qwen3vl_8b_int8_convrot.safetensors",
      "qwen_image_2.1_vae_bf16.safetensors",
    ]);
    assert.throws(() => readQwenWorkflowFile(file, "0".repeat(64)), /SHA-256 mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qwen SDK boundary mutates the pinned loader, prompt, and seed inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-qwen-sdk-boundary-"));
  const sourceFile = join(dir, "source.png");
  const sourceBytes = Buffer.from("mock source image");
  writeFileSync(sourceFile, sourceBytes);
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const graph = validateQwenWorkflowGraph(fixture());
  let submitted = 0;
  let uploaded = 0;
  let uploadedPath = "";
  let factoryInput: ApiGraph | undefined;
  const workflows = {
    fromJson(value: unknown) {
      factoryInput = value as ApiGraph;
      return {
        json: value as ApiGraph,
        setInput(nodeId: string, field: string, input: unknown) {
          const node = (value as ApiGraph)[nodeId];
          if (!node.inputs) throw new Error("missing inputs");
          node.inputs[field] = input;
        },
      };
    },
    async fromFile() { throw new Error("fromFile must not be used for the wrapped Qwen graph"); },
  };
  const client = {
    workflows,
    assets: { fromFile(path: string) { uploaded++; uploadedPath = path; return { path }; } },
    async submit() {
      assert.equal(createHash("sha256").update(readFileSync(uploadedPath)).digest("hex"), sourceHash);
      submitted++;
      return { id: "mock-job" };
    },
  } as unknown as import("@comfyorg/sdk").Comfy;
  const backend = new ComfySdkBackend({
    base: {
      file: "local-pinned-api.json",
      graph,
      workflow_sha256: "A".repeat(64),
      profile_id: "qwen-image-2.1-turbo-edit-single",
      profile_version: "1",
      model_files: [],
      prompt_node: "6",
      prompt_input: "prompt",
      seed_node: "7",
      seed_input: "noise_seed",
      output_node: "13",
      edit_source_node: "1",
      edit_source_input: "image",
      resolution_node: "6",
      resolution_input: "resolution",
      fixed_resolution: 0,
      negative_prompt_node: "6",
      negative_prompt_input: "negative_prompt",
      fixed_negative_prompt: "",
    },
  }, join(dir, "assets"), async () => client);
  const input: GenerationInput = {
    kind: "image",
    prompt: "approved design and adopted document",
    ref_images: [sourceFile],
    settings: { seed: 55 },
    resolved_refs: {
      blueprint_version_id: "bv1", item_revision_ids: [], character_revision_ids: [],
      base_image_asset_ids: [], ref_image_asset_ids: ["asset1"], asset_ids: [],
      used_asset_ids: [], document_revision_id: "docrev1",
      edit_source_asset_id: "asset1", edit_source_sha256: sourceHash,
    },
  };
  try {
  await backend.submit(input, { project_id: "p1", generation_id: "g1" });
  assert.equal(submitted, 1);
  assert.equal(uploaded, 1);
  assert.equal(factoryInput?.["1"].inputs?.image && typeof factoryInput["1"].inputs?.image, "object");
  assert.equal(factoryInput?.["6"].inputs?.prompt, input.prompt);
  assert.deepEqual(factoryInput?.["6"].inputs?.["images.image_1"], ["1", 0]);
  assert.equal(factoryInput?.["7"].inputs?.noise_seed, 55);
  assert.deepEqual(backend.describe(input), {
    connection_origin: new URL(process.env.COMFY_BASE_URL ?? "https://cloud.comfy.org").origin,
    kind: "image", workflow_file: "local-pinned-api.json", prompt_node: "6", output_node: "13",
    ref_image: true, profile_id: "qwen-image-2.1-turbo-edit-single", profile_version: "1",
    workflow_sha256: "A".repeat(64), model_files: [], model: "qwen_image_2.1_turbo_int8_convrot.safetensors",
    text_encoder: "qwen3vl_8b_int8_convrot.safetensors", vae: ["qwen_image_2.1_vae_bf16.safetensors"],
    edit_source_node: "1", edit_source_input: "image",
    applied_inputs: {
      prompt: { node: "6", input: "prompt", value: input.prompt },
      edit_source: { node: "1", input: "image", asset_id: "asset1", sha256: sourceHash },
      seed: { node: "7", input: "noise_seed", value: 55 },
      resolution: { node: "6", input: "resolution", value: 0 },
      negative_prompt: { node: "6", input: "negative_prompt", value: "" },
    },
  });
  assert.equal(existsSync(uploadedPath), false, "staged source copy is removed after the SDK consumes it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qwen backend rejects missing or multiple source images before SDK interaction", async () => {
  let created = 0;
  const client = {} as import("@comfyorg/sdk").Comfy;
  const graph = validateQwenWorkflowGraph(fixture());
  const backend = new ComfySdkBackend({
    base: {
      file: "local-pinned-api.json", graph, prompt_node: "6", prompt_input: "prompt",
      seed_node: "7", seed_input: "noise_seed", output_node: "13", edit_source_node: "1",
    },
  }, "unused", async () => { created++; return client; });
  const baseInput: GenerationInput = {
    kind: "image", prompt: "approved", ref_images: [], settings: { seed: 42 },
    resolved_refs: { blueprint_version_id: "bv1", item_revision_ids: [], character_revision_ids: [], base_image_asset_ids: [], ref_image_asset_ids: [], asset_ids: [], used_asset_ids: [] },
  };
  await assert.rejects(() => backend.submit(baseInput, { project_id: "p1", generation_id: "g1" }), /exactly one explicit source/);
  await assert.rejects(() => backend.submit({ ...baseInput, ref_images: ["a", "b"] }, { project_id: "p1", generation_id: "g2" }), /at most 1/);
  assert.equal(created, 0);
});
