import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertGeneration, updateGenerationStatus, getGeneration } from "../src/repos/generations.ts";
import { registerGenerationRoutes } from "../src/http/generationRoutes.ts";
import { Router } from "../src/http/router.ts";
import type { GenerationBackend } from "../src/gen/backend.ts";
import type { ServerConfig } from "../src/config.ts";

test("background monitoring records success, failure and cancellation before releasing local references", async () => {
  const original = process.env.VO_GENERATION_MONITOR_MS;
  process.env.VO_GENERATION_MONITOR_MS = "1000";
  const dir = mkdtempSync(join(tmpdir(), "vo-monitor-"));
  const output = join(dir, "result.png");
  writeFileSync(output, "fixture");
  const db = openDatabase(":memory:");
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const project = createProject(db, "monitor");
  const ids = ["success", "failure", "cancel"].map((job) => {
    const record = insertGeneration(db, { project_id: project.id, kind: "image", backend: "mock", inputs: "{}" });
    updateGenerationStatus(db, { id: record.id, status: "running", backend_job_id: job });
    return record.id;
  });
  let released = 0;
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const gen: GenerationBackend = {
    name: "mock", isMock: true, capabilities: { kinds: ["image"], ref_image: false },
    async submit() { return { backend_job_id: "unused" }; },
    async poll(job) {
      if (job.backend_job_id === "success") { await gate; return { status: "succeeded", output_files: [output] }; }
      return { status: "failed", error: job.backend_job_id === "cancel" ? "remote status cancelled" : "remote status failed" };
    },
    releaseLocalReferences() { released++; },
  };
  const config: ServerConfig = { port: 0, data_dir: dir, db_path: ":memory:", assets_root: dir, llm_provider: "mock", gen_backend: "mock", workflow_file: "", max_body_bytes: 1024 };
  const router = new Router();
  registerGenerationRoutes(router, { db, gen, config, checkProductionGate: () => ({ ok: true, missing: [], document_revision_ids: [] }) });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const statusUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/environment/memory-status`;
  try {
    const initial = await (await fetch(statusUrl)).json() as { local_reference_release: string; gpu_release: string };
    assert.equal(initial.local_reference_release, "waiting");
    assert.equal(initial.gpu_release, "unsupported");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(released, 0);
    assert.equal(getGeneration(db, ids[0]).status, "running");
    finish!();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(ids.map((id) => getGeneration(db, id).status), ["succeeded", "failed", "failed"]);
    assert.match(getGeneration(db, ids[2]).error ?? "", /cancelled/);
    assert.equal(released, 1);
    const final = await (await fetch(statusUrl)).json() as { local_reference_release: string; gpu_release: string };
    assert.equal(final.local_reference_release, "reference_dropped");
    assert.equal(final.gpu_release, "unsupported");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    router.close(); db.close(); rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.VO_GENERATION_MONITOR_MS; else process.env.VO_GENERATION_MONITOR_MS = original;
  }
});
