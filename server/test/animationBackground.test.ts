import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";
import { renderAnimationBackground } from "../src/gen/animationBackground.ts";
import { runOwnedProcess } from "../src/gen/ownedProcess.ts";
import { registerAnimationCompositeJobs } from "../src/http/animationCompositeJobs.ts";
import { Router } from "../src/http/router.ts";
import { getAsset, listProjectAssets } from "../src/repos/assets.ts";
import { insertCompositeJob, recordCompositeProcessEvidence, updateCompositeJob } from "../src/repos/animationCompositeJobs.ts";
import type { ProcessSnapshot } from "../src/gen/processIdentity.ts";
import type { ServerConfig } from "../src/config.ts";

test("approved shot composites verified pixels, rejects tampering and cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-animation-"));
  const db = openDatabase(":memory:");
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const config: ServerConfig = { port: 0, data_dir: dir, db_path: ":memory:", assets_root: dir, llm_provider: "mock", gen_backend: "mock", workflow_file: "", max_body_bytes: 1024 * 1024 };
  const router = buildRouter({ db, config, llm: new MockDirectorProvider(), gen: new MockGenerationBackend(dir) });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => { const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, json: await response.json() as any }; };
  const png = (filter: string) => execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", filter, "-frames:v", "1", "-threads", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
  try {
    const project = (await api("POST", "/api/projects", { name: "composition fixture" })).json;
    const assets = [];
    for (const [name, bytes] of [["background.png", png("color=blue:s=4x4,format=rgba")], ["foreground.png", png("color=red@0.5:s=4x4,format=rgba")]] as const) {
      const asset = await api("POST", "/api/assets", { owner_kind: "project", owner_id: project.id, kind: "source", name, mime: "image/png", content_base64: bytes.toString("base64") });
      assert.equal(asset.status, 201); assets.push(asset.json);
      assert.equal((await api("POST", `/api/assets/${asset.json.id}/select`, { selected: true, expected_version: asset.json.selection_version })).status, 200);
    }
    const character = (await api("POST", "/api/characters", { name: "Owl" })).json;
    const characterRevision = (await api("POST", `/api/characters/${character.id}/revisions`, { profile: {} })).json;
    const pin = (await api("PUT", `/api/projects/${project.id}/characters`, { character_id: character.id, character_revision_id: characterRevision.id, expected_version: null })).json;
    const scene = (await api("POST", `/api/projects/${project.id}/story-scenes`)).json;
    const sceneRevision = (await api("POST", `/api/items/${scene.id}/revisions`, { content: "Forest" })).json;
    await api("POST", `/api/items/${scene.id}/adopt`, { revision_id: sceneRevision.id, expected_version: scene.state_version });
    const shot = await api("POST", `/api/projects/${project.id}/animation-shots`, { scene_id: scene.id, character_id: character.id, character_revision_id: characterRevision.id, pin_version: pin.pin_version, expression: "calm", movement: "still", background: "forest", background_asset_id: assets[0].id, foreground_asset_id: assets[1].id });
    assert.equal(shot.status, 201, JSON.stringify(shot.json));
    const blueprintBefore = (await api("POST", `/api/projects/${project.id}/blueprint-versions`, {})).json;
    const renderUrl = `/api/projects/${project.id}/animation-shots/${shot.json.shot.id}/background-composite-jobs`;
    assert.equal((await api("POST", renderUrl, { blueprint_version_id: blueprintBefore.id })).status, 409);
    await api("POST", `/api/items/${shot.json.shot.id}/adopt`, { revision_id: shot.json.revision.id, expected_version: shot.json.shot.state_version });
    const blueprint = (await api("POST", `/api/projects/${project.id}/blueprint-versions`, {})).json;
    await assert.rejects(renderAnimationBackground(db, { projectId: project.id, shotId: shot.json.shot.id, blueprintId: blueprint.id, root: dir, maxBytes: config.max_body_bytes, ffmpeg: "ffmpeg", signal: AbortSignal.abort() }), /cancelled/);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let childClosed = false;
    const jobRouter = new Router();
    registerAnimationCompositeJobs(jobRouter, db, config, (database, input) => renderAnimationBackground(database, { ...input, runProcess: (_command, _args, options) => runOwnedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, onStart: (child) => { options.onStart?.(child); child.once("close", () => { childClosed = true; }); signalStarted(); } }) }), async (pids) => ({ machine: "c".repeat(64), boot: "boot", processes: pids.map((pid, index) => ({ pid, parent: index ? process.pid : 0, started: new Date().toISOString(), commandHash: "a".repeat(64), executableHash: "b".repeat(64) })) }));
    const jobServer = createServer((req, res) => void jobRouter.handle(req, res));
    await new Promise<void>((resolve) => jobServer.listen(0, "127.0.0.1", resolve));
    const jobBase = `http://127.0.0.1:${(jobServer.address() as AddressInfo).port}`;
    const jobPath = `/api/projects/${project.id}/animation-composite-jobs`;
    try {
      const beforeCount = listProjectAssets(db, project.id).length;
      const created = await fetch(`${jobBase}/api/projects/${project.id}/animation-shots/${shot.json.shot.id}/background-composite-jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprint_version_id: blueprint.id }) });
      assert.equal(created.status, 202); const job = await created.json() as { id: string };
      await started;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok((db.prepare("SELECT process_evidence FROM animation_composite_jobs WHERE id = ?").get(job.id) as { process_evidence: string | null }).process_evidence);
      const duplicate = await fetch(`${jobBase}/api/projects/${project.id}/animation-shots/${shot.json.shot.id}/background-composite-jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprint_version_id: blueprint.id }) });
      assert.equal(duplicate.status, 409);
      const cancel = await fetch(`${jobBase}${jobPath}/${job.id}/cancel`, { method: "POST" });
      assert.equal(cancel.status, 202); assert.equal((await cancel.json() as { status: string }).status, "cancelling");
      let status = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        status = (await (await fetch(`${jobBase}${jobPath}/${job.id}`)).json() as { status: string }).status;
        if (status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(status, "cancelled"); assert.equal(childClosed, true);
      assert.equal(listProjectAssets(db, project.id).length, beforeCount);
      assert.equal(readdirSync(join(dir, project.id)).some((name) => name.startsWith(".animation-composite-")), false);
    } finally { await new Promise<void>((resolve) => jobServer.close(() => resolve())); jobRouter.close(); }
    const rendered = await api("POST", renderUrl, { blueprint_version_id: blueprint.id });
    assert.equal(rendered.status, 202, JSON.stringify(rendered.json));
    let finished = rendered.json;
    for (let attempt = 0; attempt < 100 && finished.status === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = (await api("GET", `/api/projects/${project.id}/animation-composite-jobs/${rendered.json.id}`)).json;
    }
    assert.equal(finished.status, "succeeded", JSON.stringify(finished));
    assert.equal(JSON.parse(getAsset(db, finished.asset_id).meta!).composition_job_id, rendered.json.id);
    // Simulate restart after an asset committed but before job status did.
    updateCompositeJob(db, project.id, rendered.json.id, "running");
    db.prepare("UPDATE animation_composite_jobs SET process_evidence = NULL WHERE id = ?").run(rendered.json.id); // legacy record
    const recoveryUrl = `/api/projects/${project.id}/animation-composite-jobs/${rendered.json.id}`;
    assert.equal((await api("GET", recoveryUrl)).json.status, "unconfirmed");
    const recovery = await api("POST", `${recoveryUrl}/reconcile`, {});
    assert.equal(recovery.json.artifact, "hash_verified"); assert.equal(recovery.json.asset_id, finished.asset_id); assert.equal(recovery.json.safe_to_retry, false);
    assert.equal((await api("POST", `${recoveryUrl}/cancel`, {})).status, 409);
    assert.equal((await api("POST", renderUrl, { blueprint_version_id: blueprint.id })).status, 409);
    const outputPath = getAsset(db, finished.asset_id).path, outputBytes = readFileSync(outputPath);
    writeFileSync(outputPath, "altered");
    try { assert.equal((await api("POST", `${recoveryUrl}/reconcile`, {})).json.artifact, "invalid"); }
    finally { writeFileSync(outputPath, outputBytes); }
    const identity = (pid: number, parent: number) => ({ pid, parent, started: "2026-10-28T01:00:00Z", commandHash: "a".repeat(64), executableHash: "b".repeat(64) });
    const evidence: ProcessSnapshot = { machine: "c".repeat(64), boot: "boot", processes: [identity(101, 1), identity(102, 101)] };
    recordCompositeProcessEvidence(db, project.id, rendered.json.id, JSON.stringify({ jobId: rendered.json.id, snapshot: evidence }));
    let observed: ProcessSnapshot | null = evidence;
    const recoveryRouter = new Router();
    registerAnimationCompositeJobs(recoveryRouter, db, config, renderAnimationBackground, async () => observed);
    const recoveryServer = createServer((req, res) => void recoveryRouter.handle(req, res));
    await new Promise<void>((resolve) => recoveryServer.listen(0, "127.0.0.1", resolve));
    const recoveryBase = `http://127.0.0.1:${(recoveryServer.address() as AddressInfo).port}`;
    const check = async (id: string) => (await (await fetch(`${recoveryBase}/api/projects/${project.id}/animation-composite-jobs/${id}/reconcile`, { method: "POST" })).json()) as { status: string; process: string; safe_to_retry: boolean };
    try {
      assert.equal((await check(rendered.json.id)).process, "active");
      observed = null;
      assert.equal((await check(rendered.json.id)).process, "unknown");
      observed = { ...evidence, processes: [{ ...evidence.processes[0], commandHash: "d".repeat(64) }] };
      assert.equal((await check(rendered.json.id)).process, "unknown");
      assert.equal((await fetch(`${recoveryBase}/api/projects/${project.id}/animation-shots/${shot.json.shot.id}/background-composite-jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprint_version_id: blueprint.id }) })).status, 409);
      observed = { ...evidence, processes: [] };
      assert.equal((await check(rendered.json.id)).status, "succeeded");
      const missing = insertCompositeJob(db, project.id, shot.json.shot.id, blueprint.id);
      recordCompositeProcessEvidence(db, project.id, missing.id, JSON.stringify({ jobId: missing.id, snapshot: evidence }));
      const absent = await check(missing.id);
      assert.equal(absent.status, "failed"); assert.equal(absent.safe_to_retry, true);
      const retry = insertCompositeJob(db, project.id, shot.json.shot.id, blueprint.id);
      updateCompositeJob(db, project.id, retry.id, "cancelled");
    } finally { await new Promise<void>((resolve) => recoveryServer.close(() => resolve())); recoveryRouter.close(); }
    const rgba = execFileSync("ffmpeg", ["-v", "error", "-i", getAsset(db, finished.asset_id).path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    assert.ok(rgba[0] > 80 && rgba[2] > 80, `expected blended red and blue, got ${[...rgba.subarray(0, 4)]}`);
    const original = readFileSync(assets[0].path); writeFileSync(assets[0].path, Buffer.from("tampered"));
    try { assert.equal((await api("POST", renderUrl, { blueprint_version_id: blueprint.id })).status, 422); }
    finally { writeFileSync(assets[0].path, original); }
    const changed = (await api("POST", `/api/items/${shot.json.shot.id}/revisions`, { content: "Changed shot" })).json;
    assert.equal((await api("POST", `/api/items/${shot.json.shot.id}/adopt`, { revision_id: changed.id, expected_version: shot.json.shot.state_version + 1 })).status, 200);
    assert.equal((await api("POST", renderUrl, { blueprint_version_id: blueprint.id })).status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())); router.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
