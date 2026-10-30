import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ComfySdkBackend } from "../src/gen/comfySdkBackend.ts";
import type { GenerationInput } from "../src/gen/backend.ts";
import {
  readQwenTextWorkflowFile,
  validateQwenTextWorkflow,
} from "../src/gen/qwenImageTextProfile.ts";
import { readQwenWorkflowFile } from "../src/gen/qwenImageEditProfile.ts";

const workflowPath = join(import.meta.dirname, "../src/gen/workflows/txt2img.json");

test("bundled Qwen text workflow is pinned to the local Qwen model files", () => {
  const info = readQwenTextWorkflowFile(workflowPath);
  assert.deepEqual(info.model_files.map((model) => model.file), [
    "qwen_image_2.1_turbo_int8_convrot.safetensors",
    "qwen3vl_8b_int8_convrot.safetensors",
    "qwen_image_2.1_vae_bf16.safetensors",
  ]);
  assert.equal(info.sha256.length, 64);
});

test("Qwen text workflow rejects checkpoint-based fallback graphs", () => {
  const raw = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, unknown>;
  raw["99"] = {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "v1-5-pruned-emaonly-fp16.safetensors" },
  };
  assert.throws(() => validateQwenTextWorkflow(raw), /fallback/);
});

test("workflow loader rejects bytes changed after the approved profile was pinned", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-qwen-t2i-profile-"));
  try {
    const file = join(dir, "changed.json");
    const raw = JSON.stringify({ prompt: { "1": {} } });
    writeFileSync(file, raw);
    const sha = createHash("sha256").update(raw).digest("hex").toUpperCase();
    assert.throws(() => readQwenTextWorkflowFile(file), /SHA-256 mismatch/);
    assert.equal(sha.length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Qwen SDK route applies prompt, seed, and requested dimensions to its pinned graph", async () => {
  const info = readQwenTextWorkflowFile(workflowPath);
  const graph = structuredClone(info.graph);
  let submittedGraph: typeof graph | undefined;
  let submitted = 0;
  const client = {
    workflows: {
      fromJson(value: unknown) {
        submittedGraph = value as typeof graph;
        return {
          setInput(nodeId: string, field: string, input: unknown) {
            const node = submittedGraph?.[nodeId];
            if (!node?.inputs) throw new Error(`missing inputs on ${nodeId}`);
            node.inputs[field] = input;
          },
        };
      },
      async fromFile() { throw new Error("pinned in-memory graph is required"); },
    },
    assets: { fromFile() { throw new Error("text-to-image has no source image"); } },
    async submit() { submitted++; return { id: "qwen-text-job" }; },
  } as unknown as import("@comfyorg/sdk").Comfy;
  const backend = new ComfySdkBackend({
    base: {
      file: workflowPath,
      graph,
      workflow_sha256: info.sha256,
      profile_id: "qwen-image-2.1-turbo",
      profile_version: "1",
      model_files: info.model_files,
      prompt_node: "6",
      prompt_input: "prompt",
      seed_node: "7",
      seed_input: "noise_seed",
      output_node: "14",
      size_node: "11",
      width_input: "width",
      height_input: "height",
      size_scale: 0.5,
    },
  }, "unused", async () => client);
  const input: GenerationInput = {
    kind: "image",
    prompt: "approved Qwen prompt",
    ref_images: [],
    settings: { width: 1280, height: 720, seed: 1234 },
    resolved_refs: {
      blueprint_version_id: "bv1", item_revision_ids: [], character_revision_ids: [],
      base_image_asset_ids: [], ref_image_asset_ids: [], asset_ids: [], used_asset_ids: [],
      document_revision_id: "doc1",
    },
  };
  await backend.submit(input, { project_id: "p1", generation_id: "g1" });
  assert.equal(submitted, 1);
  assert.equal(submittedGraph?.["6"].inputs?.prompt, input.prompt);
  assert.equal(submittedGraph?.["7"].inputs?.noise_seed, 1234);
  assert.equal(submittedGraph?.["11"].inputs?.width, 640);
  assert.equal(submittedGraph?.["11"].inputs?.height, 360);
  assert.deepEqual(backend.describe(input).model_files, info.model_files);
});

test("one approved reference selects the pinned Qwen image-edit graph", async () => {
  const base = readQwenTextWorkflowFile(workflowPath);
  const refFile = join(import.meta.dirname, "../src/gen/workflows/qwen21_img2img.json");
  const ref = readQwenWorkflowFile(refFile);
  const dir = mkdtempSync(join(tmpdir(), "vo-qwen-ref-route-"));
  const sourceFile = join(dir, "reference.png");
  writeFileSync(sourceFile, Buffer.from("image reference"));
  let submittedGraph: Record<string, { inputs?: Record<string, unknown> }> | undefined;
  let submitted = 0;
  const client = {
    workflows: {
      fromJson(value: unknown) {
        submittedGraph = value as Record<string, { inputs?: Record<string, unknown> }>;
        return {
          setInput(nodeId: string, field: string, input: unknown) {
            const node = submittedGraph?.[nodeId];
            if (!node?.inputs) throw new Error(`missing inputs on ${nodeId}`);
            node.inputs[field] = input;
          },
        };
      },
      async fromFile() { throw new Error("pinned in-memory graph is required"); },
    },
    assets: { fromFile(path: string) { return { path }; } },
    async submit() { submitted++; return { id: "qwen-ref-job" }; },
  } as unknown as import("@comfyorg/sdk").Comfy;
  const backend = new ComfySdkBackend({
    base: {
      file: workflowPath, graph: base.graph, prompt_node: "6", prompt_input: "prompt",
      seed_node: "7", seed_input: "noise_seed", output_node: "14",
    },
    ref: {
      file: refFile, graph: ref.graph, workflow_sha256: ref.sha256,
      profile_id: "qwen-image-2.1-turbo-reference-edit", profile_version: "1",
      model_files: ref.model_files, prompt_node: "6", prompt_input: "prompt",
      seed_node: "7", seed_input: "noise_seed", output_node: "13",
      ref_image_node: "1", ref_image_input: "image",
      resolution_node: "6", resolution_input: "resolution",
      resolution_from_output_area: true,
    },
  }, join(dir, "assets"), async () => client);
  const input: GenerationInput = {
    kind: "image", prompt: "approved reference edit", ref_images: [sourceFile],
    settings: { width: 704, height: 1280, seed: 7, qwen_reference_resolution: 928 },
    resolved_refs: {
      blueprint_version_id: "bv1", item_revision_ids: [], character_revision_ids: [],
      base_image_asset_ids: [], ref_image_asset_ids: ["asset1"], asset_ids: ["asset1"],
      used_asset_ids: ["asset1"], document_revision_id: "doc1",
    },
  };
  try {
    await backend.submit(input, { project_id: "p1", generation_id: "g1" });
    assert.equal(submitted, 1);
    assert.equal(typeof submittedGraph?.["1"].inputs?.image, "object");
    assert.deepEqual(submittedGraph?.["6"].inputs?.["images.image_1"], ["1", 0]);
    assert.equal(submittedGraph?.["6"].inputs?.resolution, 928);
    assert.equal(submittedGraph?.["6"].inputs?.prompt, input.prompt);
    assert.equal(backend.describe(input).applied_resolution &&
      (backend.describe(input).applied_resolution as { value: number }).value, 928);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
