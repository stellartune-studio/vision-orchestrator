import assert from "node:assert/strict";
import { test } from "node:test";
import { ComfySdkBackend } from "../src/gen/comfySdkBackend.ts";

test("dropping VO's SDK reference permits the next request to create a client", async () => {
  let clients = 0;
  const createClient = async () => {
    clients++;
    return { async *listJobs() { /* no remote jobs */ } } as unknown as import("@comfyorg/sdk").Comfy;
  };
  const backend = new ComfySdkBackend({ base: { file: "unused", prompt_node: "1", output_node: "2" } }, ".", createClient);
  const context = { project_id: "p", generation_id: "g" };
  assert.equal(await backend.findJob(context), null);
  assert.equal(await backend.findJob(context), null);
  assert.equal(clients, 1);
  backend.releaseLocalReferences();
  assert.equal(await backend.findJob(context), null);
  assert.equal(clients, 2);
});
