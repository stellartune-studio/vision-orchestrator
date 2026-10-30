import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertGeneration, updateGenerationStatus, getGeneration } from "../src/repos/generations.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import type { GenerationBackend } from "../src/gen/backend.ts";
import type { ServerConfig } from "../src/config.ts";
import { join } from "node:path";

test("cancel requests only the recorded job and leaves state to polling", async () => {
  const db = openDatabase(":memory:");
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const project = createProject(db, "cancel fixture");
  const rec = insertGeneration(db, { project_id: project.id, kind: "image", backend: "comfy-sdk", inputs: JSON.stringify({ resolved_refs: { backend: { connection_origin: "http://localhost:8289" } } }) });
  updateGenerationStatus(db, { id: rec.id, status: "running", backend_job_id: "owned-job" });
  let requested = "";
  const gen: GenerationBackend = { name: "comfy-sdk", isMock: false, capabilities: { kinds: ["image"], ref_image: false }, describe: () => ({ connection_origin: "http://localhost:8289" }), async submit() { return { backend_job_id: "unused" }; }, async poll() { return { status: "running" }; }, async cancel(job) { requested = job.backend_job_id; } };
  const config: ServerConfig = { port: 0, data_dir: ".", db_path: ":memory:", assets_root: ".", llm_provider: "mock", gen_backend: "comfy-sdk", workflow_file: "", max_body_bytes: 1024 };
  const router = buildRouter({ db, config, llm: new MockDirectorProvider(), gen });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/generations/${rec.id}/cancel`;
    const response = await fetch(url, { method: "POST" });
    assert.equal(response.status, 202);
    assert.equal(requested, "owned-job");
    assert.equal(getGeneration(db, rec.id).status, "running");
    const other = insertGeneration(db, { project_id: project.id, kind: "image", backend: "comfy-sdk", inputs: JSON.stringify({ resolved_refs: { backend: { connection_origin: "http://localhost:9999" } } }) });
    updateGenerationStatus(db, { id: other.id, status: "running", backend_job_id: "other-job" });
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/generations/${other.id}/cancel`, { method: "POST" })).status, 409);
    assert.equal(requested, "owned-job");
    updateGenerationStatus(db, { id: rec.id, status: "succeeded" });
    assert.equal((await fetch(url, { method: "POST" })).status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});
