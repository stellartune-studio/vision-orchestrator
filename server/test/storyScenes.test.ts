import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";
import type { ServerConfig } from "../src/config.ts";
import { createCharacter, insertCharacterRevision, pinCharacterRevision } from "../src/repos/characters.ts";
import { buildGenerationInput } from "../src/gen/inputBuilder.ts";
import { assertAnimationPins } from "../src/repos/animationCast.ts";
import { registerGenerationRoutes } from "../src/http/generationRoutes.ts";
import { Router } from "../src/http/router.ts";
import type { GenerationBackend, GenerationInput } from "../src/gen/backend.ts";
import { fileURLToPath } from "node:url";

test("adding story scenes appends distinct project-scoped items", async () => {
  const db = openDatabase(":memory:");
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const project = createProject(db, "scene fixture");
  const config: ServerConfig = { port: 0, data_dir: ".", db_path: ":memory:", assets_root: ".", llm_provider: "mock", gen_backend: "mock", workflow_file: "", max_body_bytes: 1024 };
  const router = buildRouter({ db, config, llm: new MockDirectorProvider(), gen: new MockGenerationBackend(".") });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const responses = await Promise.all([1, 2].map(() => fetch(`${base}/api/projects/${project.id}/story-scenes`, { method: "POST" })));
    assert.deepEqual(responses.map((response) => response.status), [201, 201]);
    const scenes = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string; seq: number; state_version: number; project_id: string; adopted_revision_id: string | null }>));
    assert.deepEqual(scenes.map((scene) => scene.seq).sort(), [1, 2]);
    assert.notEqual(scenes[0].id, scenes[1].id);
    assert.ok(scenes.every((scene) => scene.project_id === project.id && scene.adopted_revision_id === null));
    for (const scene of scenes) {
      const revisionResponse = await fetch(`${base}/api/items/${scene.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `Scene ${scene.seq}` }) });
      const revision = await revisionResponse.json() as { id: string };
      const adopted = await fetch(`${base}/api/items/${scene.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: revision.id, expected_version: scene.state_version }) });
      assert.equal(adopted.status, 200);
      scene.state_version++;
    }
    const version = await (await fetch(`${base}/api/projects/${project.id}/blueprint-versions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string };
    const orderUrl = `${base}/api/projects/${project.id}/story-scenes/order`;
    const body = { scenes: [...scenes].reverse().map((scene) => ({ id: scene.id, expected_version: scene.state_version })) };
    const reorder = await fetch(orderUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(reorder.status, 200);
    const ordered = await reorder.json() as { id: string; seq: number; state_version: number }[];
    assert.deepEqual(ordered.map((scene) => scene.id), [...scenes].reverse().map((scene) => scene.id));
    assert.deepEqual(ordered.map((scene) => scene.seq), [1, 2]);
    const stale = await fetch(orderUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(stale.status, 409);
    const latest = (await (await fetch(`${base}/api/projects/${project.id}/state`)).json()) as { items: { id: string; seq: number }[] };
    assert.deepEqual(ordered.map((scene) => latest.items.find((item) => item.id === scene.id)?.seq), [1, 2]);
    const frozen = await (await fetch(`${base}/api/blueprint-versions/${version.id}`)).json() as { items: { item_id: string; seq: number }[] };
    assert.deepEqual(scenes.map((scene) => frozen.items.find((item) => item.item_id === scene.id)?.seq), scenes.map((scene) => scene.seq));
    const currentVersion = await (await fetch(`${base}/api/projects/${project.id}/blueprint-versions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string };
    const createdDoc = await (await fetch(`${base}/api/projects/${project.id}/documents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "script", blueprint_version_id: currentVersion.id }) })).json() as { document: { id: string; state_version: number }; revision: { id: string; content: string } };
    assert.equal((await fetch(`${base}/api/documents/${createdDoc.document.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: createdDoc.revision.id, expected_version: createdDoc.document.state_version }) })).status, 200);
    const submitted: GenerationInput[] = [];
    let cancelled = false;
    const testBackend: GenerationBackend = {
      name: "mock", isMock: true, capabilities: { kinds: ["image"], ref_image: false },
      describe() { return { connection_origin: "http://fixture.invalid" }; },
      async submit(input) { submitted.push(input); return { backend_job_id: String(submitted.length) }; },
      async cancel() { cancelled = true; },
      async poll(job) {
        if (job.backend_job_id === "2") return { status: "failed", error: "fixture failure" };
        if (job.backend_job_id === "3") return cancelled ? { status: "failed", error: "remote status cancelled" } : { status: "running" };
        return { status: "succeeded", output_files: [fileURLToPath(import.meta.url)] };
      },
    };
    const generationRouter = new Router();
    registerGenerationRoutes(generationRouter, { db, config, gen: testBackend, checkProductionGate: () => ({ ok: true, missing: [], document_revision_ids: [createdDoc.revision.id] }) });
    const generationServer = createServer((req, res) => void generationRouter.handle(req, res));
    await new Promise<void>((resolve) => generationServer.listen(0, "127.0.0.1", resolve));
    try {
      const generationBase = `http://127.0.0.1:${(generationServer.address() as AddressInfo).port}`;
      const generate = (scene: string) => fetch(`${generationBase}/api/projects/${project.id}/generations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprint_version_id: currentVersion.id, document_revision_id: createdDoc.revision.id, story_scene_id: scene, kind: "image" }) });
      const [firstResponse, concurrentResponse] = await Promise.all([generate(scenes[0].id), generate(scenes[0].id)]);
      const first = await firstResponse.json() as { id: string; status: string };
      const concurrent = await concurrentResponse.json() as { id: string; status: string };
      assert.equal(concurrent.id, first.id);
      const repeated = await (await generate(scenes[0].id)).json() as { id: string };
      assert.equal(repeated.id, first.id);
      const failed = await (await generate(scenes[1].id)).json() as { id: string; status: string };
      assert.equal(failed.status, "failed");
      const running = await (await generate(scenes[1].id)).json() as { id: string; status: string };
      assert.equal(running.status, "running");
      assert.equal((await fetch(`${generationBase}/api/generations/${running.id}/cancel`, { method: "POST" })).status, 202);
      const canceled = await (await fetch(`${generationBase}/api/generations/${running.id}`)).json() as { status: string; error: string };
      assert.equal(canceled.status, "failed"); assert.match(canceled.error, /cancelled/);
      const second = await (await generate(scenes[1].id)).json() as { id: string; status: string };
      assert.equal(second.status, "succeeded");
      assert.notEqual(second.id, first.id);
      assert.equal(submitted.length, 4);
      assert.equal(submitted[0].resolved_refs.story_scene_id, scenes[0].id);
      assert.match(submitted[0].prompt, new RegExp(`Scene ${ordered.find((scene) => scene.id === scenes[0].id)!.seq}:`));
      assert.doesNotMatch(submitted[0].prompt, new RegExp(`Scene ${ordered.find((scene) => scene.id === scenes[1].id)!.seq}:`));
      assert.equal((await generate("not-in-blueprint")).status, 422);
      const stateBeforeChange = await (await fetch(`${base}/api/projects/${project.id}/state`)).json() as { items: { id: string; state_version: number; adopted_revision_id: string }[] };
      const live = stateBeforeChange.items.find((item) => item.id === scenes[0].id)!;
      const changed = await (await fetch(`${base}/api/items/${live.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Changed scene" }) })).json() as { id: string };
      assert.equal((await fetch(`${base}/api/items/${live.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: changed.id, expected_version: live.state_version }) })).status, 200);
      assert.equal((await generate(live.id)).status, 409);
      assert.equal((await fetch(`${base}/api/items/${live.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: live.adopted_revision_id, expected_version: live.state_version + 1 }) })).status, 200);
      ordered.find((scene) => scene.id === live.id)!.state_version += 2;
    } finally {
      await new Promise<void>((resolve) => generationServer.close(() => resolve()));
      generationRouter.close();
    }
    const dialogueUrl = `${base}/api/projects/${project.id}/story-scenes/${ordered[0].id}/dialogue-proposals`;
    const dialogueBody = { document_id: createdDoc.document.id, base_revision_id: createdDoc.revision.id, expected_version: createdDoc.document.state_version + 1, content: "Hello from the scene." };
    const dialogueResponse = await fetch(dialogueUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dialogueBody) });
    assert.equal(dialogueResponse.status, 201);
    const proposal = await dialogueResponse.json() as { content: string; proposal_status: string; base_revision_id: string };
    assert.match(proposal.content, /Scene 1 — Dialogue:\nHello from the scene\./);
    assert.equal(proposal.proposal_status, "pending");
    assert.equal(proposal.base_revision_id, createdDoc.revision.id);
    const current = await (await fetch(`${base}/api/projects/${project.id}/state`)).json() as { documents: { id: string; adopted_revision_id: string }[] };
    assert.equal(current.documents.find((doc) => doc.id === createdDoc.document.id)?.adopted_revision_id, createdDoc.revision.id);
    assert.equal((await fetch(dialogueUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...dialogueBody, expected_version: 0 }) })).status, 409);
    const character = createCharacter(db, "Owl");
    const characterRevision = insertCharacterRevision(db, { character_id: character.id, profile: "{}" });
    const pin = pinCharacterRevision(db, { project_id: project.id, character_id: character.id, character_revision_id: characterRevision.id });
    const castUrl = `${base}/api/projects/${project.id}/story-scenes/${ordered[0].id}/character-proposals`;
    const castBody = { expected_version: ordered[0].state_version, characters: [{ character_id: character.id, character_revision_id: characterRevision.id, pin_version: pin.pin_version }] };
    const castResponse = await fetch(castUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(castBody) });
    assert.equal(castResponse.status, 201);
    const cast = await castResponse.json() as { revision: { id: string }; characters: { name: string }[] };
    assert.equal(cast.characters[0].name, "Owl");
    const oldCast = await (await fetch(`${base}/api/projects/${project.id}/story-scenes/${ordered[0].id}/characters`)).json() as { characters: unknown[]; proposals: { revision_id: string }[] };
    assert.deepEqual(oldCast.characters, []);
    assert.equal(oldCast.proposals[0].revision_id, cast.revision.id);
    assert.equal((await fetch(`${base}/api/items/${ordered[0].id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: cast.revision.id, expected_version: ordered[0].state_version }) })).status, 200);
    const castVersion = await (await fetch(`${base}/api/projects/${project.id}/blueprint-versions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string };
    const previousInput = buildGenerationInput(db, { project_id: project.id, blueprint_version_id: currentVersion.id, backend: new MockGenerationBackend("."), kind: "image" });
    assert.doesNotMatch(previousInput.prompt, /Characters in scene: Owl/);
    const input = buildGenerationInput(db, { project_id: project.id, blueprint_version_id: castVersion.id, backend: new MockGenerationBackend("."), kind: "image" });
    assert.match(input.prompt, /Characters in scene: Owl/);
    const castScene = buildGenerationInput(db, { project_id: project.id, blueprint_version_id: castVersion.id, backend: new MockGenerationBackend("."), kind: "image", story_scene_id: ordered[0].id });
    assert.deepEqual(castScene.resolved_refs.character_revision_ids, [characterRevision.id]);
    const otherScene = buildGenerationInput(db, { project_id: project.id, blueprint_version_id: castVersion.id, backend: new MockGenerationBackend("."), kind: "image", story_scene_id: ordered[1].id });
    assert.deepEqual(otherScene.resolved_refs.character_revision_ids, []);
    const animationUrl = `${base}/api/projects/${project.id}/animation-shots`;
    const shotBody = { scene_id: ordered[0].id, character_id: character.id, character_revision_id: characterRevision.id, pin_version: pin.pin_version, expression: "curious", movement: "turns slowly", background: "moonlit forest" };
    const makeShot = (body: object) => fetch(animationUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await makeShot({ ...shotBody, pin_version: pin.pin_version + 1 })).status, 409);
    const shotResponse = await makeShot(shotBody); assert.equal(shotResponse.status, 201);
    const shot = await shotResponse.json() as { shot: { id: string; state_version: number; seq: number; parent_item_id: string }; revision: { id: string; proposal_status: string } };
    assert.equal(shot.shot.parent_item_id, ordered[0].id); assert.equal(shot.revision.proposal_status, "pending");
    assert.equal((db.prepare("SELECT character_revision_id FROM animation_shot_cast WHERE revision_id = ?").get(shot.revision.id) as { character_revision_id: string }).character_revision_id, characterRevision.id);
    assert.equal((await fetch(`${base}/api/items/${shot.shot.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: shot.revision.id, expected_version: shot.shot.state_version }) })).status, 200);
    const revisedShot = await (await fetch(`${base}/api/items/${shot.shot.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Revised shot direction" }) })).json() as { id: string };
    assert.equal((db.prepare("SELECT character_revision_id FROM animation_shot_cast WHERE revision_id = ?").get(revisedShot.id) as { character_revision_id: string }).character_revision_id, characterRevision.id);
    const shotVersion = await (await fetch(`${base}/api/projects/${project.id}/blueprint-versions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string };
    const shotInput = buildGenerationInput(db, { project_id: project.id, blueprint_version_id: shotVersion.id, backend: new MockGenerationBackend("."), kind: "image" });
    assert.match(shotInput.prompt, /Expression: curious/); assert.match(shotInput.prompt, /Movement: turns slowly/); assert.match(shotInput.prompt, /Background direction: moonlit forest/);
    const editedScene = await (await fetch(`${base}/api/items/${ordered[0].id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "A changed scene" }) })).json() as { id: string };
    const pendingCast = await (await fetch(`${base}/api/projects/${project.id}/story-scenes/${ordered[0].id}/characters`)).json() as { proposals: { revision_id: string; characters: { name: string }[] }[] };
    assert.equal(pendingCast.proposals.find((proposal) => proposal.revision_id === editedScene.id)?.characters[0].name, "Owl");
    assert.throws(() => db.prepare("DELETE FROM scene_revision_characters WHERE revision_id = ?").run(cast.revision.id), /immutable/);
    assert.throws(() => db.prepare("INSERT INTO scene_revision_characters (revision_id, character_id, character_revision_id, name) VALUES (?, ?, ?, ?)").run(cast.revision.id, character.id, characterRevision.id, "Changed"), /pending/);
    const newCharacterRevision = insertCharacterRevision(db, { character_id: character.id, profile: "{}" });
    pinCharacterRevision(db, { project_id: project.id, character_id: character.id, character_revision_id: newCharacterRevision.id });
    assert.throws(() => assertAnimationPins(db, project.id), /character pin changed/);
    assert.equal((await fetch(`${base}/api/projects/${project.id}/blueprint-versions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 409);
    const oldInput = buildGenerationInput(db, { project_id: project.id, blueprint_version_id: castVersion.id, backend: new MockGenerationBackend("."), kind: "image" });
    assert.match(oldInput.prompt, /Characters in scene: Owl/);
    assert.equal((await fetch(castUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(castBody) })).status, 409);
    assert.equal((await fetch(`${base}/api/projects/missing/story-scenes`, { method: "POST" })).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
