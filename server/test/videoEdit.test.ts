import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertAsset } from "../src/repos/assets.ts";
import {
  buildVideoEditArgs,
  createEditedVideo,
  validateVideoEditRequest,
} from "../src/editor/videoEdit.ts";

const srt = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";

test("video edit validates clip bounds and SRT cue timing", () => {
  assert.equal(validateVideoEditRequest({
    source_asset_id: "source",
    start_seconds: 2,
    end_seconds: 5,
    subtitles_srt: srt,
  }).end_seconds, 5);
  assert.throws(() => validateVideoEditRequest({
    source_asset_id: "source", start_seconds: 3, end_seconds: 2,
  }), /end_seconds must be greater/);
  assert.throws(() => validateVideoEditRequest({
    source_asset_id: "source", start_seconds: 0, end_seconds: 2,
    subtitles_srt: "1\n00:00:00,000 --> 00:00:03,000\nToo late",
  }), /within the edited clip/);
  assert.throws(() => validateVideoEditRequest({
    source_asset_id: "source", start_seconds: 0, end_seconds: 2,
    subtitles_srt: "1\n00:00:00,000 --> 00:00:01,000\n{\\an8}unsafe override",
  }), /ASS override/);
});

test("video edit command uses argv, preserves audio, trims, and adds subtitles only when supplied", () => {
  const request = { source_asset_id: "source", start_seconds: 1.25, end_seconds: 4.75 };
  const args = buildVideoEditArgs(request, "C:/assets/source.mp4", "new.mp4", "captions.srt");
  assert.ok(args.includes("-ss"));
  assert.ok(args.includes("-t"));
  assert.ok(args.includes("3.5"));
  assert.ok(args.includes("-map"));
  assert.ok(args.includes("0:a?"));
  assert.ok(args.includes("subtitles=filename='captions.srt'"));
  assert.equal(args.at(-1), "new.mp4");
  assert.ok(!args.includes("-y"));
});

test("edited video is stored as a new project asset with source and edit provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "vo-video-edit-"));
  const assetsRoot = join(root, "assets");
  const db = openDatabase(join(root, "app.db"));
  try {
    migrate(db, join(import.meta.dirname, "../src/db/migrations"));
    const project = createProject(db, "Video edit test");
    const sourceDir = join(assetsRoot, project.id);
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "source.mp4");
    writeFileSync(sourcePath, Buffer.from("source fixture"));
    const source = insertAsset(db, {
      owner_kind: "project", owner_id: project.id, kind: "generated",
      path: sourcePath, mime: "video/mp4", sha256: createHash("sha256").update("source fixture").digest("hex"),
    });
    const result = await createEditedVideo(db, project.id, {
      source_asset_id: source.id,
      start_seconds: 0,
      end_seconds: 1.5,
      subtitles_srt: srt,
    }, {
      ffmpeg_bin: "ffmpeg",
      ffprobe_bin: "ffprobe",
      assets_root: assetsRoot,
      probe_duration: async (_binary, file) => file === sourcePath ? 10 : 1.5,
      run_ffmpeg: async (_binary, args, cwd) => {
        assert.ok(args.some((value) => value.startsWith("subtitles=filename='")));
        writeFileSync(join(cwd, String(args.at(-1))), Buffer.from("edited fixture"), { flag: "wx" });
      },
    });
    assert.equal(result.asset.kind, "edited-video");
    assert.equal(result.asset.mime, "video/mp4");
    assert.notEqual(result.asset.id, source.id);
    assert.equal(result.source_asset_id, source.id);
    assert.equal(result.subtitle_sha256, createHash("sha256").update(srt).digest("hex"));
    const meta = JSON.parse(result.asset.meta!);
    assert.equal(meta.source_asset_id, source.id);
    assert.equal(meta.source_sha256, createHash("sha256").update("source fixture").digest("hex"));
    assert.equal(meta.start_seconds, 0);
    assert.equal(meta.end_seconds, 1.5);
    assert.equal(meta.subtitles_srt, srt);
    assert.equal(readFileSync(sourcePath, "utf8"), "source fixture");
    assert.equal(readFileSync(result.asset.path, "utf8"), "edited fixture");
    assert.deepEqual(readdirSync(sourceDir).sort(), ["source.mp4", `${result.asset.id}.mp4`].sort());
    await assert.rejects(() => createEditedVideo(db, project.id, {
      source_asset_id: source.id, start_seconds: 0, end_seconds: 12,
    }, {
      ffmpeg_bin: "ffmpeg", ffprobe_bin: "ffprobe", assets_root: assetsRoot,
      probe_duration: async () => 10,
      run_ffmpeg: async () => assert.fail("FFmpeg must not run for an out-of-range edit"),
    }), /exceeds source duration/);
    assert.deepEqual(readdirSync(sourceDir).sort(), ["source.mp4", `${result.asset.id}.mp4`].sort());
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("rejects changed source bytes before and during editing and allows retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "vo-edit-integrity-"));
  const assetsRoot = join(root, "assets");
  const db = openDatabase(join(root, "app.db"));
  try {
    migrate(db, join(import.meta.dirname, "../src/db/migrations"));
    const project = createProject(db, "Integrity");
    const dir = join(assetsRoot, project.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "source.mp4");
    writeFileSync(path, "original");
    const source = insertAsset(db, { owner_kind: "project", owner_id: project.id, kind: "generated", path, mime: "video/mp4", sha256: createHash("sha256").update("original").digest("hex") });
    const request = { source_asset_id: source.id, start_seconds: 0, end_seconds: 1, subtitles_srt: srt };
    const opts = { ffmpeg_bin: "ffmpeg", ffprobe_bin: "ffprobe", assets_root: assetsRoot, probe_duration: async () => 1 };
    writeFileSync(path, "replace!");
    await assert.rejects(() => createEditedVideo(db, project.id, request, { ...opts, run_ffmpeg: async () => assert.fail("must not render changed source") }), /source video.*hash/i);
    writeFileSync(path, "original");
    await assert.rejects(() => createEditedVideo(db, project.id, request, { ...opts, run_ffmpeg: async (_binary, args, cwd) => {
      writeFileSync(join(cwd, String(args.at(-1))), "output");
      writeFileSync(path, "changed while rendering");
    } }), /source video changed/i);
    assert.deepEqual(readdirSync(dir), ["source.mp4"]);
    writeFileSync(path, "original");
    let collision = "";
    await assert.rejects(() => createEditedVideo(db, project.id, request, { ...opts, run_ffmpeg: async (_binary, args, cwd) => {
      const name = String(args.at(-1));
      collision = join(dir, name);
      writeFileSync(collision, "preexisting user file", { flag: "wx" });
      writeFileSync(join(cwd, name), "output");
    } }), /EEXIST/);
    assert.equal(readFileSync(collision, "utf8"), "preexisting user file");
    const result = await createEditedVideo(db, project.id, request, { ...opts, run_ffmpeg: async (_binary, args, cwd) => { writeFileSync(join(cwd, String(args.at(-1))), "output"); } });
    assert.ok(result.asset.id);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("real FFmpeg trims audio and burns SRT captions", async () => {
  const root = mkdtempSync(join(tmpdir(), "vo-edit-ffmpeg-"));
  const assetsRoot = join(root, "assets");
  const db = openDatabase(join(root, "app.db"));
  const run = (bin: string, args: string[]) => execFileSync(bin, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  try {
    migrate(db, join(import.meta.dirname, "../src/db/migrations"));
    const project = createProject(db, "Real edit");
    const dir = join(assetsRoot, project.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "source.mp4");
    run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
    const source = insertAsset(db, { owner_kind: "project", owner_id: project.id, kind: "generated", path, mime: "video/mp4", sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    const opts = { ffmpeg_bin: "ffmpeg", ffprobe_bin: "ffprobe", assets_root: assetsRoot };
    const base = { source_asset_id: source.id, start_seconds: 0.25, end_seconds: 1.25 };
    const plain = await createEditedVideo(db, project.id, base, opts);
    const captioned = await createEditedVideo(db, project.id, { ...base, subtitles_srt: srt }, opts);
    const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", captioned.asset.path]).toString());
    assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.15);
    assert.ok(probe.streams.some((stream: {codec_type: string}) => stream.codec_type === "audio"));
    const frame = (file: string) => run("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    assert.notDeepEqual(frame(plain.asset.path), frame(captioned.asset.path));
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), source.sha256);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
