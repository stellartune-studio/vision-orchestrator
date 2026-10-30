import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

test("instrumental proposal, adoption, preview and export retain asset guards", async () => {
  const root = mkdtempSync(join(tmpdir(), "vo-mv-instrumental-"));
  const db = openDatabase(":memory:");
  const oldFont = process.env.PROMOTION_FONT_FILE;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    delete process.env.PROMOTION_FONT_FILE;
    migrate(db, join(import.meta.dirname, "../src/db/migrations"));
    const project = createProject(db, "instrumental");
    const audioPath = join(root, "audio.wav"), videoPath = join(root, "video.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "pcm_s16le", audioPath]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
    const add = (path: string, mime: string) => {
      const bytes = readFileSync(path);
      const asset = insertAsset(db, { owner_kind: "project", owner_id: project.id, kind: "material", path, mime, sha256: createHash("sha256").update(bytes).digest("hex") });
      setAssetSelected(db, asset.id, true, asset.selection_version);
      return asset;
    };
    const audio = add(audioPath, "audio/wav"), video = add(videoPath, "video/mp4");
    const version = transact(db, () => createBlueprintVersion(db, project.id));
    const doc = insertDocument(db, { project_id: project.id, kind: "script" });
    const base = insertDocumentRevision(db, { document_id: doc.id, content: "Original", source: "user", blueprint_version_id: version.id });
    transact(db, () => adoptDocumentRevision(db, { document_id: doc.id, revision_id: base.id, expected_version: doc.state_version }));
    const config = { port: 0, data_dir: ".", db_path: ":memory:", assets_root: root, llm_provider: "mock" as const, gen_backend: "mock" as const, workflow_file: "", max_body_bytes: 2 * 1024 * 1024 };
    const router = buildRouter({ db, config, llm: new MockDirectorProvider(), gen: new MockGenerationBackend(".") });
    server = createServer((req, res) => void router.handle(req, res));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const prefix = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}`;
    const post = (path: string, body: object) => fetch(prefix + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const body = { document_id: doc.id, base_revision_id: base.id, expected_version: 1, audio_asset_id: audio.id, lines: [], beats: [0, 1], cuts: [{ start: 0, video_asset_id: video.id }, { start: 1, video_asset_id: video.id }] };
    assert.equal((await post("/mv-lyrics-proposals", { ...body, audio_asset_id: video.id })).status, 400);
    assert.equal((await post("/mv-lyrics-proposals", { ...body, expected_version: 0 })).status, 409);
    assert.equal((await post("/mv-lyrics-proposals", { ...body, cuts: [{ start: 0, video_asset_id: "missing" }] })).status, 400);
    assert.equal((await post("/mv-lyrics-proposals", { ...body, beats: [3] })).status, 400);
    const proposed = await post("/mv-lyrics-proposals", body); assert.equal(proposed.status, 201, await proposed.clone().text());
    const revision = await proposed.json() as { id: string };
    const renderBody = { revision_id: revision.id, video_asset_id: video.id };
    assert.equal((await post("/mv-previews", renderBody)).status, 409);
    transact(db, () => adoptDocumentRevision(db, { document_id: doc.id, revision_id: revision.id, expected_version: getDocument(db, doc.id).state_version }));
    const plan = await (await fetch(`${prefix}/mv-plans/${revision.id}`)).json() as { lyrics_json: string };
    assert.deepEqual(JSON.parse(plan.lyrics_json), []);
    const originalAudio = readFileSync(audioPath); writeFileSync(audioPath, "changed");
    assert.equal((await post("/mv-exports", renderBody)).status, 422); writeFileSync(audioPath, originalAudio);
    const originalVideo = readFileSync(videoPath); writeFileSync(videoPath, "changed");
    assert.equal((await post("/mv-exports", renderBody)).status, 422); writeFileSync(videoPath, originalVideo);
    for (const [endpoint, kind] of [["/mv-previews", "mv-preview"], ["/mv-exports", "mv-export"]]) {
      const response = await post(endpoint, renderBody); assert.equal(response.status, 201, await response.clone().text());
      const result = await response.json() as { kind: string; path: string; meta: string };
      assert.equal(result.kind, kind);
      const meta = JSON.parse(result.meta); assert.deepEqual(meta.lyrics, []); assert.equal(meta.font_sha256, null);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", result.path], { encoding: "utf8" }));
      assert.deepEqual(probe.streams.map((s: { codec_type: string }) => s.codec_type).sort(), ["audio", "video"]);
      assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.1);
    }
  } finally {
    if (oldFont === undefined) delete process.env.PROMOTION_FONT_FILE; else process.env.PROMOTION_FONT_FILE = oldFont;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
