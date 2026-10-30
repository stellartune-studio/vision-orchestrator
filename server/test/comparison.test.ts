import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertGeneration, updateGenerationStatus } from "../src/repos/generations.ts";
import { insertAsset } from "../src/repos/assets.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";

test("comparison survives clients, rejects conflicts and foreign or missing outputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-compare-")), db = openDatabase(":memory:");
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const a = createProject(db, "A"), b = createProject(db, "B");
  const first = insertGeneration(db, { project_id: a.id, kind: "image", inputs: "{}", backend: "mock" });
  const second = insertGeneration(db, { project_id: a.id, kind: "image", inputs: "{}", backend: "mock" });
  const foreign = insertGeneration(db, { project_id: b.id, kind: "image", inputs: "{}", backend: "mock" });
  const file = join(dir, "fixture.png"); writeFileSync(file, "fixture");
  const asset = insertAsset(db, { owner_kind: "project", owner_id: a.id, kind: "image", path: file, mime: "image/png" });
  const foreignAsset = insertAsset(db, { owner_kind: "project", owner_id: b.id, kind: "image", path: file, mime: "image/png" });
  const wrongOutput = insertGeneration(db, { project_id: a.id, kind: "image", inputs: "{}", backend: "mock" });
  updateGenerationStatus(db, { id: wrongOutput.id, status: "succeeded", output_asset_id: foreignAsset.id });
  updateGenerationStatus(db, { id: first.id, status: "succeeded", output_asset_id: asset.id });
  const config = { port: 0, data_dir: dir, db_path: ":memory:", assets_root: dir, llm_provider: "mock" as const, gen_backend: "mock" as const, workflow_file: "", max_body_bytes: 1024 * 1024 };
  const router = buildRouter({ db, config, llm: new MockDirectorProvider(), gen: new MockGenerationBackend(dir) });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${a.id}/comparison`;
  const read = async () => (await fetch(base)).json() as Promise<{ ids: string[] | null; version: number | null; stale: boolean }>;
  const put = (ids: unknown, expected_version: unknown) => fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, expected_version }) });
  try {
    assert.deepEqual(await read(), { ids: null, version: null, stale: false });
    assert.equal((await put([foreign.id], null)).status, 400);
    assert.equal((await put([wrongOutput.id], null)).status, 400);
    assert.equal((await put([first.id, first.id], null)).status, 400);
    assert.equal((await put([first.id, second.id], null)).status, 200);
    assert.deepEqual(await read(), { ids: [first.id, second.id], version: 1, stale: false });
    assert.equal((await put([second.id], null)).status, 409);
    assert.equal((await put([second.id], 1)).status, 200);
    assert.equal((await put([first.id, second.id], 1)).status, 409);
    assert.equal((await put([first.id, second.id], 2)).status, 200);
    unlinkSync(file);
    assert.deepEqual(await read(), { ids: [second.id], version: 3, stale: true });
    assert.equal((await put([first.id], 3)).status, 400);
    assert.equal((await put([second.id], 3)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())); router.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
