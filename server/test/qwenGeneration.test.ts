import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import type { GenerationBackend, GenerationInput } from "../src/gen/backend.ts";
import type { ServerConfig } from "../src/config.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");
let dir: string;
let server: Server;
let base: string;
let db: ReturnType<typeof openDatabase>;
let submits: GenerationInput[];
let outputFile: string;

const gen: GenerationBackend = {
  name: "comfy-sdk",
  isMock: false,
  capabilities: { kinds: ["image"], ref_image: true, max_ref_images: 1 },
  describe: () => ({
    profile_id: "qwen-image-2.1-turbo-edit-single",
    profile_version: "1",
    workflow_sha256: "9F5480090EDF7E0BCBC391DED0F9F702C2DA297875EC307CDAE40D17A0EF7B15",
    output_node: "13",
    model_files: ["diffusion", "text_encoder", "vae"],
  }),
  async submit(input) {
    submits.push(structuredClone(input));
    return { backend_job_id: `mock-${submits.length}` };
  },
  async poll() {
    return { status: "succeeded", output_files: [outputFile] };
  },
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "vo-qwen-e2e-"));
  db = openDatabase(join(dir, "app.db"));
  migrate(db, MIGRATIONS);
  outputFile = join(dir, "mock-generated.png");
  writeFileSync(outputFile, Buffer.from("mock output"));
  submits = [];
  const config: ServerConfig = {
    port: 0,
    data_dir: dir,
    db_path: join(dir, "app.db"),
    assets_root: join(dir, "assets"),
    llm_provider: "mock",
    gen_backend: "comfy-sdk",
    gen_profile: "qwen-image-2.1-turbo-edit-single",
    workflow_file: "unused",
    max_body_bytes: 32 * 1024 * 1024,
  };
  const router = buildRouter({ db, config, llm: new MockDirectorProvider(), gen });
  server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  for (let i = 0; i < 10; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
});

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
};

async function makeProject(name: string) {
  const project = await api("POST", "/api/projects", { name });
  const pid = project.json.id as string;
  const state = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const [kind, content] of [["intent", "approved prompt intent"], ["output_policy", "source resolution"]]) {
    const item = state.items.find((entry: any) => entry.kind === kind);
    const revision = await api("POST", `/api/items/${item.id}/revisions`, { content });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: revision.json.id,
      expected_version: item.state_version,
    });
  }
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script", blueprint_version_id: bv.json.id,
  });
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  const docView = st.documents.find((entry: any) => entry.id === doc.json.document.id);
  const adopted = await api("POST", `/api/documents/${docView.id}/adopt`, {
    revision_id: doc.json.revision.id,
    expected_version: docView.state_version,
  });
  assert.equal(adopted.status, 200);
  return { pid, bv: bv.json, docRevisionId: doc.json.revision.id };
}

async function uploadImage(projectId: string, name: string) {
  const pixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=", "base64");
  const asset = await api("POST", "/api/assets", {
    owner_kind: "project", owner_id: projectId, kind: "source", name,
    mime: "image/png", content_base64: pixelPng.toString("base64"),
  });
  assert.equal(asset.status, 201);
  return asset.json;
}

test("Qwen generation handler validates an explicit source and records an isolated output", async () => {
  const { pid, bv, docRevisionId } = await makeProject("qwen target");
  const source = await uploadImage(pid, "edit-source.png");
  const before = readFileSync(source.path);
  const originalHash = createHash("sha256").update(before).digest("hex");
  const otherProject = await api("POST", "/api/projects", { name: "other project" });
  const foreignSource = await uploadImage(otherProject.json.id, "foreign.png");

  for (const body of [
    { blueprint_version_id: bv.id, document_revision_id: docRevisionId, kind: "image" },
    { blueprint_version_id: bv.id, document_revision_id: docRevisionId, kind: "image", edit_source_asset_id: source.id, mask_asset_id: source.id },
    { blueprint_version_id: bv.id, document_revision_id: docRevisionId, kind: "image", edit_source_asset_id: foreignSource.id },
  ]) {
    const rejected = await api("POST", `/api/projects/${pid}/generations`, body);
    assert.ok(rejected.status === 400 || rejected.status === 422, JSON.stringify(rejected));
  }
  assert.equal(submits.length, 0, "invalid/missing/mask/foreign inputs are rejected before SDK submit");

  const accepted = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.id,
    document_revision_id: docRevisionId,
    kind: "image",
    edit_source_asset_id: source.id,
    seed: 1234,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.status, "succeeded");
  assert.equal(submits.length, 1);
  const input = JSON.parse(accepted.json.inputs);
  assert.equal(input.prompt.includes("approved prompt intent"), true);
  assert.equal(input.settings.output_policy, "source resolution");
  assert.equal(input.settings.seed, 1234);
  assert.equal(input.resolved_refs.edit_source_asset_id, source.id);
  assert.equal(input.resolved_refs.edit_source_sha256, originalHash);
  assert.equal(input.resolved_refs.document_revision_id, docRevisionId);
  assert.equal(input.resolved_refs.backend.profile_id, "qwen-image-2.1-turbo-edit-single");
  assert.equal(input.resolved_refs.backend.output_node, "13");
  assert.notEqual(accepted.json.output_asset_id, source.id);
  assert.equal(createHash("sha256").update(readFileSync(source.path)).digest("hex"), originalHash);
});

test("scene edit source is approved, frozen, exclusive and revalidated before generation", async () => {
  const { pid } = await makeProject("scene edit source");
  const source = await uploadImage(pid, "approved.png");
  const alternative = await uploadImage(pid, "other.png");
  const foreignProject = await api("POST", "/api/projects", { name: "foreign" });
  const foreign = await uploadImage(foreignProject.json.id, "foreign.png");
  for (const asset of [source, alternative]) assert.equal((await api("POST", `/api/assets/${asset.id}/select`, { selected: true, expected_version: asset.selection_version })).status, 200);
  const scene = (await api("POST", `/api/projects/${pid}/story-scenes`)).json;
  const initial = (await api("POST", `/api/items/${scene.id}/revisions`, { content: "A quiet forest" })).json;
  assert.equal((await api("POST", `/api/items/${scene.id}/adopt`, { revision_id: initial.id, expected_version: scene.state_version })).status, 200);
  const proposalUrl = `/api/projects/${pid}/story-scenes/${scene.id}/edit-source-proposals`;
  assert.equal((await api("POST", proposalUrl, { asset_id: foreign.id, expected_version: 1 })).status, 422);
  const proposed = await api("POST", proposalUrl, { asset_id: source.id, expected_version: 1 });
  assert.equal(proposed.status, 201);
  assert.equal((await api("POST", `/api/items/${scene.id}/adopt`, { revision_id: proposed.json.id, expected_version: 1 })).status, 200);
  const bv = (await api("POST", `/api/projects/${pid}/blueprint-versions`, {})).json;
  const doc = (await api("POST", `/api/projects/${pid}/documents`, { kind: "script", blueprint_version_id: bv.id })).json;
  assert.equal((await api("POST", `/api/documents/${doc.document.id}/adopt`, { revision_id: doc.revision.id, expected_version: doc.document.state_version })).status, 200);
  const generate = (assetId: string) => api("POST", `/api/projects/${pid}/generations`, { blueprint_version_id: bv.id, document_revision_id: doc.revision.id, kind: "image", story_scene_id: scene.id, edit_source_asset_id: assetId });
  assert.equal((await generate(alternative.id)).status, 409);
  const countBefore = submits.length;
  const result = await generate(source.id);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(submits.length, countBefore + 1);
  assert.deepEqual(submits.at(-1)!.resolved_refs.ref_image_asset_ids, [source.id]);
  assert.equal(submits.at(-1)!.resolved_refs.story_scene_revision_id, proposed.json.id);
  assert.equal((await generate(source.id)).json.id, result.json.id);
  const original = readFileSync(source.path);
  writeFileSync(source.path, Buffer.from("changed"));
  try { assert.equal((await generate(source.id)).status, 422); }
  finally { writeFileSync(source.path, original); }
});

test("scene may approve the assigned character's pinned PNG as its single edit source", async () => {
  const { pid } = await makeProject("character scene source");
  const character = (await api("POST", "/api/characters", { name: "Owl" })).json;
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=";
  const asset = await api("POST", "/api/assets", { owner_kind: "character", owner_id: character.id, kind: "source", name: "owl.png", mime: "image/png", content_base64: pixel });
  assert.equal(asset.status, 201);
  const revision = (await api("POST", `/api/characters/${character.id}/revisions`, { profile: {}, base_image_asset_id: asset.json.id })).json;
  const pin = await api("PUT", `/api/projects/${pid}/characters`, { character_id: character.id, character_revision_id: revision.id, expected_version: null });
  assert.equal(pin.status, 200);
  const scene = (await api("POST", `/api/projects/${pid}/story-scenes`)).json;
  const initial = (await api("POST", `/api/items/${scene.id}/revisions`, { content: "Owl in the forest" })).json;
  await api("POST", `/api/items/${scene.id}/adopt`, { revision_id: initial.id, expected_version: 0 });
  const cast = await api("POST", `/api/projects/${pid}/story-scenes/${scene.id}/character-proposals`, { expected_version: 1, characters: [{ character_id: character.id, character_revision_id: revision.id, pin_version: pin.json.pin_version }] });
  assert.equal(cast.status, 201, JSON.stringify(cast.json));
  await api("POST", `/api/items/${scene.id}/adopt`, { revision_id: cast.json.revision.id, expected_version: 1 });
  const proposal = await api("POST", `/api/projects/${pid}/story-scenes/${scene.id}/edit-source-proposals`, { expected_version: 2, asset_id: asset.json.id });
  assert.equal(proposal.status, 201, JSON.stringify(proposal.json));
  await api("POST", `/api/items/${scene.id}/adopt`, { revision_id: proposal.json.id, expected_version: 2 });
  const blueprint = (await api("POST", `/api/projects/${pid}/blueprint-versions`, {})).json;
  const doc = (await api("POST", `/api/projects/${pid}/documents`, { kind: "script", blueprint_version_id: blueprint.id })).json;
  await api("POST", `/api/documents/${doc.document.id}/adopt`, { revision_id: doc.revision.id, expected_version: doc.document.state_version });
  const result = await api("POST", `/api/projects/${pid}/generations`, { blueprint_version_id: blueprint.id, document_revision_id: doc.revision.id, kind: "image", story_scene_id: scene.id, edit_source_asset_id: asset.json.id });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.deepEqual(submits.at(-1)!.resolved_refs.ref_image_asset_ids, [asset.json.id]);
});
