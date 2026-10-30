import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, transact } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertAsset, setAssetSelected } from "../src/repos/assets.ts";
import { createBlueprintVersion } from "../src/repos/blueprints.ts";
import { insertDocument, insertDocumentRevision, adoptDocumentRevision, getDocument } from "../src/repos/documents.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";

test("poster approval, asset integrity, rendering and provenance through routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "vo-poster-test-"));
  const db = openDatabase(":memory:"); migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const project = createProject(db, "synthetic poster"), other = createProject(db, "other");
  const stillPath = join(root, "still.png"), motionPath = join(root, "motion.mp4");
  // Tiny synthetic fixtures only; never copy existing user assets for this test.
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=4:d=1", "-frames:v", "1", "-threads", "1", stillPath], { windowsHide: true });
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=4:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", motionPath], { windowsHide: true });
  const register = (path: string, mime: string, owner = project.id) => {
    const bytes = readFileSync(path); const asset = insertAsset(db, { owner_kind: "project", owner_id: owner, kind: "material", path, mime, sha256: createHash("sha256").update(bytes).digest("hex") });
    if (owner === project.id) setAssetSelected(db, asset.id, true, asset.selection_version);
    return asset;
  };
  const still = register(stillPath, "image/png"), motion = register(motionPath, "video/mp4"), foreign = register(motionPath, "video/mp4", other.id);
  const version = transact(db, () => createBlueprintVersion(db, project.id));
  const doc = insertDocument(db, { project_id: project.id, kind: "script" });
  const base = insertDocumentRevision(db, { document_id: doc.id, content: "Poster", source: "user", blueprint_version_id: version.id });
  transact(db, () => adoptDocumentRevision(db, { document_id: doc.id, revision_id: base.id, expected_version: doc.state_version }));
  const config = { port: 0, data_dir: root, db_path: ":memory:", assets_root: root, llm_provider: "mock" as const, gen_backend: "mock" as const, workflow_file: "", max_body_bytes: 1024 * 1024 };
  const server = createServer((req, res) => void build.handle(req, res));
  const build = buildRouter({ db, config, llm: new MockDirectorProvider(), gen: new MockGenerationBackend(root) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}`;
  const post = (path: string, body: object) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const layout = { width: 64, height: 64, fps: 4, duration: 2, layers: [{ kind: "motion", x: 0, y: 0, width: 64, height: 64, loop_frames: 4 }, { kind: "still", x: 0, y: 0, width: 16, height: 16 }] };
  const proposal = { document_id: doc.id, base_revision_id: base.id, expected_version: 1, still_asset_id: still.id, motion_asset_id: motion.id, layout };
  try {
    assert.equal((await post("/poster-proposals", { ...proposal, motion_asset_id: foreign.id })).status, 422);
    assert.equal((await post("/poster-proposals", { ...proposal, expected_version: 0 })).status, 409);
    assert.equal((await post("/poster-proposals", { ...proposal, layout: { ...layout, layers: [{ ...layout.layers[0], x: 64 }] } })).status, 400);
    const response = await post("/poster-proposals", proposal); assert.equal(response.status, 201);
    const pending = await response.json() as { id: string; proposal_status: string }; assert.equal(pending.proposal_status, "pending");
    assert.equal((await post("/poster-previews", { revision_id: pending.id })).status, 409);
    assert.equal((await fetch(`${url}/poster-plans/${pending.id}`)).status, 409);
    transact(db, () => adoptDocumentRevision(db, { document_id: doc.id, revision_id: pending.id, expected_version: getDocument(db, doc.id).state_version }));
    assert.equal((await fetch(`${url.replace(project.id, other.id)}/poster-plans/${pending.id}`)).status, 409);
    assert.throws(() => db.prepare("UPDATE poster_plans SET still_sha256 = 'changed' WHERE revision_id = ?").run(pending.id), /immutable/);
    const original = readFileSync(motionPath); writeFileSync(motionPath, "tampered");
    assert.equal((await post("/poster-exports", { revision_id: pending.id })).status, 422); writeFileSync(motionPath, original);
    const exported = await post("/poster-exports", { revision_id: pending.id });
    const data = await exported.json() as { id: string; path: string; meta: string; error?: string };
    assert.equal(exported.status, 201, data.error); const meta = JSON.parse(data.meta) as { revision_id: string; layout: typeof layout; after: { width: number; height: number; duration: number } };
    assert.equal(meta.revision_id, pending.id); assert.deepEqual(meta.layout, layout); assert.equal(meta.after.width, 64); assert.equal(meta.after.height, 64); assert.ok(Math.abs(meta.after.duration - 2) <= 0.26);
    const fetched = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets/${data.id}/file`); assert.equal(fetched.status, 200); assert.ok((await fetched.arrayBuffer()).byteLength > 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true }); }
});
