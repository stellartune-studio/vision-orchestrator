import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import type { ServerConfig } from "../src/config.ts";
import type { GenerationBackend } from "../src/gen/backend.ts";

test("reference size requires confirmation and rejects mismatched actual output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-reference-grid-"));
  const db = openDatabase(join(dir, "app.db"));
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  let submits = 0;
  let outputFile = "";
  let outputDimensions = { width: 1, height: 1 };
  const gen: GenerationBackend = { name: "comfy-sdk", isMock: false, capabilities: { kinds: ["image"], ref_image: true }, async submit() { submits++; return { backend_job_id: "fixture" }; }, async poll() { return { status: "succeeded", output_files: [outputFile] }; } };
  const config: ServerConfig = { port: 0, data_dir: dir, db_path: join(dir, "app.db"), assets_root: join(dir, "assets"), llm_provider: "mock", gen_backend: "comfy-sdk", gen_profile: "qwen-image-2.1-turbo", workflow_file: "unused", max_body_bytes: 1024 * 1024 };
  const router = buildRouter({ db, config, gen, llm: new MockDirectorProvider(), probeDimensions: async (path) => path === outputFile ? outputDimensions : ({ width: 1, height: 1 }) });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const p = (await api("POST", "/api/projects", { name: "grid fixture" })).body;
    const state = (await api("GET", `/api/projects/${p.id}/state`)).body;
    for (const [kind, content] of [["intent", "owl"], ["output_policy", "9:16"]]) {
      const item = state.items.find((i: any) => i.kind === kind);
      const rev = (await api("POST", `/api/items/${item.id}/revisions`, { content })).body;
      await api("POST", `/api/items/${item.id}/adopt`, { revision_id: rev.id, expected_version: item.state_version });
    }
    const asset = (await api("POST", "/api/assets", { owner_kind: "project", owner_id: p.id, kind: "image", name: "reference.png", mime: "image/png", content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=" })).body;
    await api("POST", `/api/assets/${asset.id}/select`, { selected: true, expected_version: asset.selection_version });
    const bv = (await api("POST", `/api/projects/${p.id}/blueprint-versions`, {})).body;
    const doc = (await api("POST", `/api/projects/${p.id}/documents`, { kind: "script", blueprint_version_id: bv.id })).body;
    await api("POST", `/api/documents/${doc.document.id}/adopt`, { revision_id: doc.revision.id, expected_version: doc.document.state_version });
    const result = await api("POST", `/api/projects/${p.id}/generations`, { kind: "image", blueprint_version_id: bv.id, document_revision_id: doc.revision.id });
    assert.equal(result.status, 422);
    assert.match(result.body.error, /Confirm the current Qwen reference size/);
    assert.equal(submits, 0);
    assert.equal((await api("GET", `/api/projects/${p.id}/state`)).body.generations.length, 0);
    const preview = await api("POST", `/api/projects/${p.id}/qwen-reference-size`, { blueprint_version_id: bv.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual([preview.body.source_width, preview.body.source_height, preview.body.width, preview.body.height], [1, 1, 960, 960]);
    const request = { kind: "image", blueprint_version_id: bv.id, document_revision_id: doc.revision.id, reference_size: preview.body };
    const stale = await api("POST", `/api/projects/${p.id}/generations`, { ...request, reference_size: { ...preview.body, source_sha256: "changed" } });
    assert.equal(stale.status, 422);
    assert.equal(submits, 0);
    const sourceBytes = readFileSync(asset.path);
    writeFileSync(asset.path, Buffer.from("changed source"));
    const changed = await api("POST", `/api/projects/${p.id}/generations`, request);
    assert.equal(changed.status, 422);
    assert.match(changed.body.error, /recorded hash/);
    writeFileSync(asset.path, sourceBytes);
    outputFile = join(config.assets_root, p.id, "fixture-output.png");
    copyFileSync(asset.path, outputFile);
    const generated = await api("POST", `/api/projects/${p.id}/generations`, request);
    assert.equal(generated.status, 200);
    assert.equal(generated.body.status, "failed");
    assert.match(generated.body.error, /expected 960×960, received 1×1/);
    const saved = JSON.parse(generated.body.inputs);
    assert.equal(saved.settings.qwen_reference_size.source_sha256, preview.body.source_sha256);
    assert.deepEqual([saved.settings.width, saved.settings.height, saved.settings.qwen_reference_resolution], [960, 960, 960]);
    assert.equal(submits, 1);
    outputDimensions = { width: 960, height: 960 };
    copyFileSync(asset.path, outputFile);
    const successful = await api("POST", `/api/projects/${p.id}/generations`, request);
    assert.equal(successful.body.status, "succeeded");
    assert.ok(successful.body.output_asset_id);
    assert.equal(submits, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
