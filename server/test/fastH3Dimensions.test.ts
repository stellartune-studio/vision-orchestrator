import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ComfySdkBackend } from "../src/gen/comfySdkBackend.ts";
import type { GenerationInput } from "../src/gen/backend.ts";

test("FastH3 SDK submission applies both requested dimensions to the reference scaler", async () => {
  const file = join(import.meta.dirname, "../src/gen/workflows/fasth3_i2v.json");
  const graph = JSON.parse(readFileSync(file, "utf8")) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  let submittedGraph: typeof graph | undefined;
  const client = {
    workflows: { fromJson(value: unknown) {
      submittedGraph = value as typeof graph;
      return { setInput(id: string, name: string, value: unknown) { submittedGraph![id].inputs[name] = value; } };
    } },
    assets: { fromFile() { return { id: "reference" }; } },
    async submit() { return { id: "job" }; },
  } as unknown as import("@comfyorg/sdk").Comfy;
  const spec = { file, graph, prompt_node: "105:104", prompt_input: "prompt", output_node: "92", ref_image_node: "136", size_node: "142" };
  const backend = new ComfySdkBackend({ base: spec, video: spec }, "unused", async () => client);
  const input: GenerationInput = {
    kind: "video", prompt: "approved scene", ref_images: ["reference.png"],
    settings: { width: 768, height: 1344 },
    resolved_refs: { blueprint_version_id: "v1", item_revision_ids: [], character_revision_ids: [], base_image_asset_ids: [], ref_image_asset_ids: [], asset_ids: [], used_asset_ids: [] },
  };
  await backend.submit(input, { project_id: "p1", generation_id: "g1" });
  assert.equal(backend.describe(input).ref_image, true);
  assert.equal(submittedGraph?.["142"].class_type, "ImageScale");
  assert.equal(submittedGraph?.["142"].inputs.width, 768);
  assert.equal(submittedGraph?.["142"].inputs.height, 1344);
  assert.deepEqual(submittedGraph?.["105:104"].inputs.width, ["141", 0]);
  assert.deepEqual(submittedGraph?.["105:104"].inputs.height, ["141", 1]);
  await assert.rejects(() => backend.submit({ ...input, settings: { width: 720, height: 1280 } }, { project_id: "p1", generation_id: "g2" }), /multiples of 32/);
  await assert.rejects(() => backend.submit({ ...input, settings: {} }, { project_id: "p1", generation_id: "g3" }), /multiples of 32/);
});

test("a remotely canceled job terminates polling", async () => {
  const client = { jobs: { async get() { return { status: "canceled" }; } } } as unknown as import("@comfyorg/sdk").Comfy;
  const spec = { file: "unused", prompt_node: "1", output_node: "2" };
  const backend = new ComfySdkBackend({ base: spec }, "unused", async () => client);
  assert.deepEqual(await backend.poll({ backend_job_id: "job" }, { project_id: "p1", generation_id: "g1" }),
    { status: "failed", error: "remote status canceled" });
});

test("cancellation targets the identified SDK job", async () => {
  let canceled: string | undefined;
  const client = { jobs: { async get(id: string) { return { async cancel() { canceled = id; } }; } } } as unknown as import("@comfyorg/sdk").Comfy;
  const spec = { file: "unused", prompt_node: "1", output_node: "2" };
  const backend = new ComfySdkBackend({ base: spec }, "unused", async () => client);
  await backend.cancel({ backend_job_id: "job-123" });
  assert.equal(canceled, "job-123");
});
