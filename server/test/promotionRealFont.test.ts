import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, transact } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertAsset } from "../src/repos/assets.ts";
import { insertDocument, insertDocumentRevision, adoptDocumentRevision } from "../src/repos/documents.ts";
import { insertPromotionLayout } from "../src/repos/promotionLayouts.ts";
import { createPromotionPreview } from "../src/gen/promotionPreview.ts";

test("FFmpeg renders a wrapped Japanese title and rejects unavailable glyphs", { skip: !existsSync("C:\\Windows\\Fonts\\msgothic.ttc"), timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "vo-promo-font-"));
  const db = openDatabase(":memory:");
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  try {
    const sourcePath = join(root, "source.mp4"), logoPath = join(root, "logo.png");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=5:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=8x8", "-frames:v", "1", "-threads", "1", logoPath]);
    const project = createProject(db, "font fixture");
    const asset = (path: string, mime: string) => insertAsset(db, { owner_kind: "project", owner_id: project.id, kind: "fixture", path, mime, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    const source = asset(sourcePath, "video/mp4"), logo = asset(logoPath, "image/png");
    const doc = insertDocument(db, { project_id: project.id, kind: "script" });
    const revision = insertDocumentRevision(db, { document_id: doc.id, content: "title", source: "user" });
    const title = "月の灯り、静かな森を照らす。夜が優しく包みます。";
    insertPromotionLayout(db, { revision_id: revision.id, logo_asset_id: logo.id, logo_sha256: logo.sha256!, title, layout: { logo: { x: 0, y: 0, width: 0.1, height: 0.1 }, title: { x: 0.1, y: 0.1, width: 0.5, height: 0.75 } } });
    transact(db, () => adoptDocumentRevision(db, { document_id: doc.id, revision_id: revision.id, expected_version: doc.state_version }));
    const result = await createPromotionPreview(db, { project_id: project.id, revision_id: revision.id, source_asset_id: source.id, assets_root: root, max_bytes: 1024 * 1024, ffmpeg: "ffmpeg", ffprobe: "ffprobe", font: "C:\\Windows\\Fonts\\msgothic.ttc" });
    const meta = JSON.parse(result.meta!) as { title: string; rendered_title: string; font_size_px: number };
    assert.equal(meta.title, title); assert.ok(meta.rendered_title.includes("\n")); assert.equal(meta.rendered_title.replaceAll("\n", ""), title); assert.ok(meta.font_size_px >= 12);
    const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", result.path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    assert.ok(pixels.some((value) => value > 100));
    if (process.env.VO_TEST_PROMO_FRAME) execFileSync("ffmpeg", ["-v", "error", "-i", result.path, "-frames:v", "1", "-threads", "1", process.env.VO_TEST_PROMO_FRAME]);
    const unsupported = insertDocumentRevision(db, { document_id: doc.id, content: "unsupported", source: "user" });
    insertPromotionLayout(db, { revision_id: unsupported.id, logo_asset_id: logo.id, logo_sha256: logo.sha256!, title: "月🧑", layout: { logo: { x: 0, y: 0, width: 0.1, height: 0.1 }, title: { x: 0.1, y: 0.1, width: 0.5, height: 0.75 } } });
    transact(db, () => adoptDocumentRevision(db, { document_id: doc.id, revision_id: unsupported.id, expected_version: doc.state_version + 1 }));
    await assert.rejects(createPromotionPreview(db, { project_id: project.id, revision_id: unsupported.id, source_asset_id: source.id, assets_root: root, max_bytes: 1024 * 1024, ffmpeg: "ffmpeg", ffprobe: "ffprobe", font: "C:\\Windows\\Fonts\\msgothic.ttc" }), /lacks verified glyphs/);
    const explicit = insertDocumentRevision(db, { document_id: doc.id, content: "explicit lines", source: "user" });
    insertPromotionLayout(db, { revision_id: explicit.id, logo_asset_id: logo.id, logo_sha256: logo.sha256!, title: "月\r\n\r\n灯り", layout: { logo: { x: 0, y: 0, width: 0.1, height: 0.1 }, title: { x: 0.1, y: 0.1, width: 0.5, height: 0.75 } } });
    transact(db, () => adoptDocumentRevision(db, { document_id: doc.id, revision_id: explicit.id, expected_version: doc.state_version + 2 }));
    const explicitResult = await createPromotionPreview(db, { project_id: project.id, revision_id: explicit.id, source_asset_id: source.id, assets_root: root, max_bytes: 1024 * 1024, ffmpeg: "ffmpeg", ffprobe: "ffprobe", font: "C:\\Windows\\Fonts\\msgothic.ttc" });
    assert.equal(JSON.parse(explicitResult.meta!).rendered_title, "月\n\n灯り");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
