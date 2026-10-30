import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase, transact } from "../src/db/connection.ts";
import { migrate, migrateFile } from "../src/db/migrate.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";
import { ComfySdkBackend } from "../src/gen/comfySdkBackend.ts";
import { buildGenerationInput } from "../src/gen/inputBuilder.ts";
import type {
  GenerationBackend,
  GenerationJob,
  GenerationPollResult,
} from "../src/gen/backend.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertMessage, listMessages } from "../src/repos/messages.ts";
import {
  adoptRevision,
  insertRevision,
  listItemViews,
} from "../src/repos/items.ts";
import {
  createCharacter,
  insertCharacterRevision,
  pinCharacterRevision,
} from "../src/repos/characters.ts";
import { insertAsset } from "../src/repos/assets.ts";
import {
  getGeneration,
  insertGeneration,
  updateGenerationStatus,
} from "../src/repos/generations.ts";
import { createBlueprintVersion } from "../src/repos/blueprints.ts";
import { UnprocessableError } from "../src/repos/errors.ts";
import { isUnder, resolveUnder, safeBasename } from "../src/util/paths.ts";
import { mimeForPath } from "../src/util/media.ts";
import type { ServerConfig } from "../src/config.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");

let dir: string;
let server: Server;
let base: string;
let db: ReturnType<typeof openDatabase>;
let config: ServerConfig;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "vo-safety-"));
  db = openDatabase(join(dir, "app.db"));
  migrate(db, MIGRATIONS);
  config = {
    port: 0,
    data_dir: dir,
    db_path: join(dir, "app.db"),
    assets_root: join(dir, "assets"),
    llm_provider: "mock",
    gen_backend: "mock",
    workflow_file: "",
    max_body_bytes: 4096,
  };
  const router = buildRouter({
    db,
    config,
    llm: new MockDirectorProvider(),
    gen: new MockGenerationBackend(config.assets_root),
  });
  server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

const api = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function fileCountUnder(p: string): number {
  if (!existsSync(p)) return 0;
  return readdirSync(p, { recursive: true }).length;
}

// ---------- asset upload: path safety ----------

test("asset upload: traversal/absolute owner_id is rejected and writes nothing", async () => {
  const before = fileCountUnder(config.assets_root);
  for (const owner_id of [
    "../escape-safety",
    "..\\escape-safety",
    "C:/escape-safety-abs",
    "C:\\escape-safety-abs",
  ]) {
    const res = await api("POST", "/api/assets", {
      owner_kind: "project",
      owner_id,
      kind: "image",
      name: "x.png",
      content_base64: TINY_PNG_B64,
    });
    assert.equal(res.status, 400, `owner_id ${owner_id}`);
  }
  assert.equal(existsSync(join(dir, "escape-safety")), false);
  assert.equal(fileCountUnder(config.assets_root), before);
});

test("asset upload: unknown owner is rejected before any file is written", async () => {
  const res = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: "no-such-owner",
    kind: "image",
    name: "x.png",
    content_base64: TINY_PNG_B64,
  });
  assert.equal(res.status, 400);
  assert.equal(
    existsSync(join(config.assets_root, "no-such-owner")),
    false,
    "owner directory must not be created for a rejected upload",
  );
});

test("asset upload: hostile filename is stored under a server-generated name", async () => {
  const proj = await api("POST", "/api/projects", { name: "asset-owner" });
  const pid = proj.json.id;
  const res = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "image",
    name: "..\\..\\evil name?.png",
    content_base64: TINY_PNG_B64,
  });
  assert.equal(res.status, 201);
  const p = res.json.path as string;
  // stored directly under <assets_root>/<owner_id>/, never deeper or outside
  assert.equal(resolve(dirname(p)), resolve(join(config.assets_root, pid)));
  // the stored basename contains no caller-supplied path pieces
  assert.match(basename(p), /^[0-9a-f-]{36}\.png$/);
  assert.equal(existsSync(p), true);
});

test("asset upload: DB failure leaves no orphan file", async () => {
  const proj = await api("POST", "/api/projects", { name: "orphan" });
  const pid = proj.json.id;
  // Force insertAsset to fail AFTER the owner check: rename the table.
  db.exec("ALTER TABLE assets RENAME TO assets_bak");
  const res = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "image",
    name: "x.png",
    content_base64: TINY_PNG_B64,
  });
  db.exec("ALTER TABLE assets_bak RENAME TO assets");
  assert.equal(res.status, 500);
  assert.equal(
    fileCountUnder(join(config.assets_root, pid)),
    0,
    "the staged file must be removed when the DB registration fails",
  );
});

test("asset file endpoint refuses records pointing outside assets_root", async () => {
  const proj = await api("POST", "/api/projects", { name: "scope" });
  const outside = join(dir, "outside-secret.txt");
  writeFileSync(outside, "secret");
  const asset = transact(db, () =>
    insertAsset(db, {
      owner_kind: "project",
      owner_id: proj.json.id,
      kind: "doc",
      path: outside,
    }),
  );
  const res = await fetch(`${base}/api/assets/${asset.id}/file`);
  assert.equal(res.status, 404);
  await res.text();
});

// ---------- request body limit ----------

test("body over the limit via Content-Length is 413", async () => {
  const res = await api("POST", "/api/projects", {
    name: "x".repeat(6000),
  });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /limit|large|exceed/i);
});

test("body over the limit via chunked streaming is 413", async () => {
  const status = await new Promise<number>((resolveP, reject) => {
    const req = request(
      `${base}/api/projects`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolveP(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    // no Content-Length header — the server must count actual bytes
    req.write('{"name":"');
    req.write("x".repeat(6000));
    req.end('"}');
  });
  assert.equal(status, 413);
});

test("body within the limit still works", async () => {
  const res = await api("POST", "/api/projects", { name: "small" });
  assert.equal(res.status, 201);
});

// ---------- message ordering ----------

test("messages keep insertion order even at identical timestamps", () => {
  const local = openDatabase(":memory:");
  migrate(local, MIGRATIONS);
  const project = transact(local, () => createProject(local, "order"));
  const wanted: string[] = [];
  transact(local, () => {
    for (let i = 0; i < 12; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      insertMessage(local, {
        project_id: project.id,
        role,
        content: `m${i}`,
      });
      wanted.push(`m${i}`);
    }
  });
  const got = listMessages(local, project.id).map((m) => m.content);
  assert.deepEqual(got, wanted);
  local.close();
});

// ---------- reference image limits ----------

function fixtureWithTwoBaseImages() {
  const local = openDatabase(":memory:");
  migrate(local, MIGRATIONS);
  const project = transact(local, () => createProject(local, "gen"));
  const item = listItemViews(local, project.id)[0];
  const rev = transact(local, () =>
    insertRevision(local, {
      item_id: item.id,
      content: "adopted content",
      source: "user",
    }),
  );
  transact(local, () =>
    adoptRevision(local, {
      item_id: item.id,
      revision_id: rev.id,
      expected_version: item.state_version,
    }),
  );
  for (const name of ["c1", "c2"]) {
    const ch = transact(local, () => createCharacter(local, name));
    const asset = transact(local, () =>
      insertAsset(local, {
        owner_kind: "character",
        owner_id: ch.id,
        kind: "image",
        path: join(dir, `${name}.png`),
      }),
    );
    const chRev = transact(local, () =>
      insertCharacterRevision(local, {
        character_id: ch.id,
        profile: "{}",
        base_image_asset_id: asset.id,
      }),
    );
    transact(local, () =>
      pinCharacterRevision(local, {
        project_id: project.id,
        character_id: ch.id,
        character_revision_id: chRev.id,
      }),
    );
  }
  const bv = transact(local, () => createBlueprintVersion(local, project.id));
  return { local, project, bv };
}

const singleRefBackend: GenerationBackend = {
  name: "single-ref-stub",
  isMock: false,
  capabilities: { kinds: ["image"], ref_image: true, max_ref_images: 1 },
  submit: () => Promise.reject(new Error("unreachable")),
  poll: () => Promise.reject(new Error("unreachable")),
};

test("buildGenerationInput refuses more ref images than the backend accepts", () => {
  const { local, project, bv } = fixtureWithTwoBaseImages();
  assert.throws(
    () =>
      buildGenerationInput(local, {
        project_id: project.id,
        blueprint_version_id: bv.id,
        backend: singleRefBackend,
        kind: "image",
      }),
    (err) =>
      err instanceof UnprocessableError && /reference/i.test(err.message),
  );
  local.close();
});

// ---------- path helpers ----------

test("resolveUnder rejects separators, drives, dot-segments, absolute paths", () => {
  const root = join(dir, "root");
  assert.equal(resolveUnder(root, "ok-123"), join(root, "ok-123"));
  for (const bad of [
    "..",
    ".",
    "",
    "a/b",
    "a\\b",
    "..\\x",
    "../x",
    "C:/abs",
    "C:\\abs",
    "/abs",
    "\\abs",
    "drive:x",
  ]) {
    assert.throws(() => resolveUnder(root, bad), /unsafe|escapes/i, bad);
  }
});

test("safeBasename reduces remote names to a single safe segment", () => {
  assert.equal(safeBasename("../../etc/passwd"), "passwd");
  assert.equal(safeBasename("a\\b\\c.png"), "c.png");
  assert.equal(safeBasename("C:\\dir\\file.png"), "file.png");
  assert.equal(safeBasename(".."), "output");
  assert.equal(safeBasename("my file?.png"), "my_file_.png");
});

test("mimeForPath only resolves allowlisted extensions", () => {
  assert.equal(mimeForPath("a.png"), "image/png");
  assert.equal(mimeForPath("clip.MP4"), "video/mp4");
  assert.equal(mimeForPath("a.exe"), undefined);
  assert.equal(mimeForPath("page.html"), undefined);
  assert.equal(mimeForPath("evil.png.exe"), undefined);
  assert.equal(mimeForPath("no-ext"), undefined);
});

test("isUnder confines records to the storage root", () => {
  const root = join(dir, "root");
  assert.equal(isUnder(root, join(root, "a.png")), true);
  assert.equal(isUnder(root, join(root, "sub", "a.png")), true);
  assert.equal(isUnder(root, root), false);
  assert.equal(isUnder(root, join(root, "..", "x")), false);
  assert.equal(isUnder(root, join(dir, "elsewhere")), false);
});

// ---------- media type consistency ----------

test("asset upload: only allowlisted, self-consistent media types are accepted", async () => {
  const proj = await api("POST", "/api/projects", { name: "media" });
  const pid = proj.json.id;
  const up = (name: string, b64: string, mime?: string) =>
    api("POST", "/api/assets", {
      owner_kind: "project",
      owner_id: pid,
      kind: "image",
      name,
      content_base64: b64,
      mime,
    });
  const TXT = Buffer.from("just text").toString("base64");
  // active content and executables are not storable media
  assert.equal((await up("evil.html", TXT)).status, 400);
  assert.equal((await up("evil.svg", TXT)).status, 400);
  assert.equal((await up("run.exe", TXT)).status, 400);
  // extension present but content is not that type
  assert.equal((await up("fake.png", TXT)).status, 400);
  // declared mime contradicts the extension
  assert.equal((await up("pic.png", TINY_PNG_B64, "text/html")).status, 400);
  // consistent uploads work — stored mime is the canonical one
  const ok = await up("pic.png", TINY_PNG_B64, "image/png");
  assert.equal(ok.status, 201);
  assert.equal(ok.json.mime, "image/png");
  assert.equal((await up("pic2.png", TINY_PNG_B64)).status, 201);
  // extension-less name: allowed only via a known mime
  const mimeOnly = await up("noext", TINY_PNG_B64, "image/png");
  assert.equal(mimeOnly.status, 201);
  assert.match(mimeOnly.json.path as string, /\.png$/);
  assert.equal((await up("noext2", TINY_PNG_B64)).status, 400);
});

test("asset file endpoint serves canonical mime, ignoring stored/caller mime", async () => {
  const proj = await api("POST", "/api/projects", { name: "mime" });
  const pid = proj.json.id;
  const up = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "image",
    name: "pic.png",
    content_base64: TINY_PNG_B64,
  });
  assert.equal(up.status, 201);
  // a DB row claiming text/html still serves as the real image type
  const sneaky = transact(db, () =>
    insertAsset(db, {
      owner_kind: "project",
      owner_id: pid,
      kind: "image",
      path: up.json.path,
      mime: "text/html",
    }),
  );
  const res = await fetch(`${base}/api/assets/${sneaky.id}/file`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  await res.arrayBuffer();
  // a record whose stored file is active content is never served
  const htmlPath = join(config.assets_root, pid, "page.html");
  writeFileSync(htmlPath, "<script>alert(1)</script>");
  const htmlAsset = transact(db, () =>
    insertAsset(db, {
      owner_kind: "project",
      owner_id: pid,
      kind: "doc",
      path: htmlPath,
      mime: "text/html",
    }),
  );
  const res2 = await fetch(`${base}/api/assets/${htmlAsset.id}/file`);
  assert.equal(res2.status, 404);
  await res2.text();
});

// ---------- link traversal ----------

test("upload into a junctioned owner dir writes nothing outside the root", async () => {
  const proj = await api("POST", "/api/projects", { name: "junc" });
  const pid = proj.json.id;
  const outside = join(dir, "outside-junction");
  mkdirSync(outside);
  mkdirSync(config.assets_root, { recursive: true });
  symlinkSync(outside, join(config.assets_root, pid), "junction");
  const res = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "image",
    name: "a.png",
    content_base64: TINY_PNG_B64,
  });
  assert.notEqual(res.status, 201);
  assert.deepEqual(readdirSync(outside), []);
});

test("serving an asset that links outside the root is refused", async (t) => {
  const proj = await api("POST", "/api/projects", { name: "linkserve" });
  const pid = proj.json.id;
  const up = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "image",
    name: "a.png",
    content_base64: TINY_PNG_B64,
  });
  assert.equal(up.status, 201);
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "secret");
  // a legal extension that actually resolves (via link) to outside content
  const linkPath = join(config.assets_root, pid, "linked.png");
  try {
    symlinkSync(secret, linkPath, "file");
  } catch (e) {
    t.diagnostic(`file symlink unavailable here: ${e}`);
    return;
  }
  const asset = transact(db, () =>
    insertAsset(db, {
      owner_kind: "project",
      owner_id: pid,
      kind: "image",
      path: linkPath,
    }),
  );
  const res = await fetch(`${base}/api/assets/${asset.id}/file`);
  assert.equal(res.status, 404);
  await res.text();
});

// ---------- message seq integrity ----------

test("message seq: backfill preserves stored order; seq stays unique", () => {
  const local = openDatabase(":memory:");
  // simulate a pre-0002 database: apply only the first migration, then
  // write rows the OLD way (no seq column existed yet)
  local.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  migrateFile(
    local,
    join(MIGRATIONS, "0001_init.sql"),
    "0001_init.sql",
  );
  // row-only fixture: createProject seeds kinds the 0001 schema rejects
  local
    .prepare("INSERT INTO projects (id, name) VALUES ('old-proj', 'old')")
    .run();
  const project = { id: "old-proj" };
  for (const [i, c] of ["first", "second", "third"].entries()) {
    local
      .prepare(
        "INSERT INTO messages (id, project_id, role, content) VALUES (?, ?, 'user', ?)",
      )
      .run(`old-${i}`, project.id, c);
  }
  migrate(local, MIGRATIONS);
  assert.deepEqual(
    listMessages(local, project.id).map((m) => m.content),
    ["first", "second", "third"],
  );
  // seq uniqueness is schema-enforced
  assert.throws(
    () =>
      local
        .prepare(
          "INSERT INTO messages (id, project_id, role, content, seq) VALUES ('dup', ?, 'user', 'x', 1)",
        )
        .run(project.id),
    /UNIQUE/i,
  );
  // new inserts continue the sequence without colliding
  transact(local, () =>
    insertMessage(local, {
      project_id: project.id,
      role: "assistant",
      content: "fourth",
    }),
  );
  assert.equal(
    listMessages(local, project.id).at(-1)?.content,
    "fourth",
  );
  local.close();
});

// ---------- generation poll dedupe + cleanup ----------

function seedRunningGeneration(projectId: string) {
  const rec = transact(db, () =>
    insertGeneration(db, {
      project_id: projectId,
      kind: "image",
      inputs: "{}",
      backend: "mock",
    }),
  );
  const outDir = join(config.assets_root, projectId);
  mkdirSync(outDir, { recursive: true });
  const genFile = join(outDir, `gen-${rec.id}.png`);
  writeFileSync(genFile, Buffer.from(TINY_PNG_B64, "base64"));
  transact(db, () =>
    updateGenerationStatus(db, {
      id: rec.id,
      status: "running",
      backend_job_id: `mock:${genFile}`,
    }),
  );
  return { rec, genFile };
}

test("concurrent polls register the output asset exactly once", async () => {
  const proj = await api("POST", "/api/projects", { name: "dedupe" });
  const { rec, genFile } = seedRunningGeneration(proj.json.id);
  const [a, b] = await Promise.all([
    fetch(`${base}/api/generations/${rec.id}`),
    fetch(`${base}/api/generations/${rec.id}`),
  ]);
  const [ja, jb] = await Promise.all([a.json(), b.json()]);
  assert.equal(ja.status, "succeeded");
  assert.equal(jb.status, "succeeded");
  const n = (
    db
      .prepare("SELECT COUNT(*) AS n FROM assets WHERE path = ?")
      .get(genFile) as { n: number }
  ).n;
  assert.equal(n, 1, "both polls must not double-register the output");
});

test("failed output registration removes downloaded files", async () => {
  const proj = await api("POST", "/api/projects", { name: "gencleanup" });
  const { rec, genFile } = seedRunningGeneration(proj.json.id);
  db.exec("ALTER TABLE assets RENAME TO assets_bak");
  const res = await fetch(`${base}/api/generations/${rec.id}`);
  const json = await res.json();
  db.exec("ALTER TABLE assets_bak RENAME TO assets");
  assert.equal(json.status, "failed");
  assert.equal(
    existsSync(genFile),
    false,
    "downloaded output must be removed when registration fails",
  );
});

// ---------- deterministic poll races ----------
//
// The mock backend resolves synchronously, so `Promise.all([GET, GET])`
// cannot actually interleave the registration transactions. This gated
// backend writes ("downloads") its output file, then blocks inside
// poll() — after the download, before the handler reaches the DB
// commit — until the test releases it. Release order decides which
// poll commits first.

class GatedPollBackend implements GenerationBackend {
  readonly name = "gated-poll";
  readonly isMock = true;
  readonly capabilities = {
    kinds: ["image"] as const,
    ref_image: false,
  };

  /** staged "downloads" waiting for test-controlled release */
  readonly pending: {
    file: string;
    release: (r?: GenerationPollResult) => void;
  }[] = [];

  private dir: string;
  private n = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  submit(): Promise<GenerationJob> {
    return Promise.reject(new Error("not used — seed the job directly"));
  }

  poll(): Promise<GenerationPollResult> {
    this.n += 1;
    const file = join(this.dir, `staged-${this.n}.png`);
    writeFileSync(file, Buffer.from(TINY_PNG_B64, "base64"));
    return new Promise((resolve) => {
      this.pending.push({
        file,
        release: (r) =>
          resolve(r ?? { status: "succeeded", output_files: [file] }),
      });
    });
  }
}

const waitUntil = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(cond(), true, `timed out waiting for ${what}`);
};

/** A second HTTP server sharing db/config but driven by `gen`. */
const serveWith = async (gen: GenerationBackend) => {
  const srv = createServer((req, res) =>
    void buildRouter({
      db,
      config,
      llm: new MockDirectorProvider(),
      gen,
    }).handle(req, res),
  );
  await new Promise<void>((r) => srv.listen(0, r));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { srv, b };
};

const seedRacedGeneration = async (projectName: string) => {
  const proj = await api("POST", "/api/projects", { name: projectName });
  const outDir = join(config.assets_root, proj.json.id);
  mkdirSync(outDir, { recursive: true });
  const rec = transact(db, () =>
    insertGeneration(db, {
      project_id: proj.json.id,
      kind: "image",
      inputs: "{}",
      backend: "gated-poll",
    }),
  );
  transact(db, () =>
    updateGenerationStatus(db, {
      id: rec.id,
      status: "running",
      backend_job_id: "gated-job",
    }),
  );
  return { proj, rec, outDir };
};

test("raced polls: one asset; winner file survives and is served; loser staged file removed", async () => {
  const { proj, rec, outDir } = await seedRacedGeneration("race-win");
  const gated = new GatedPollBackend(outDir);
  const { srv, b } = await serveWith(gated);
  try {
    const p1 = fetch(`${b}/api/generations/${rec.id}`).then((r) => ({
      tag: 1,
      r,
    }));
    const p2 = fetch(`${b}/api/generations/${rec.id}`).then((r) => ({
      tag: 2,
      r,
    }));
    await waitUntil(
      () => gated.pending.length === 2,
      "both downloads to reach the pre-commit gate",
    );
    const winnerFile = gated.pending[0].file;
    const loserFile = gated.pending[1].file;
    gated.pending[0].release(); // this attempt commits first → wins
    const win = await Promise.race([p1, p2]);
    const jWin = await win.r.json();
    assert.equal(jWin.status, "succeeded");
    gated.pending[1].release(); // the second attempt commits → loses
    const lose = await (win.tag === 1 ? p2 : p1);
    const jLose = await lose.r.json();
    assert.equal(jLose.status, "succeeded");
    // the same output of the same generation is registered once
    assert.equal(jLose.output_asset_id, jWin.output_asset_id);
    const rows = db
      .prepare(
        "SELECT path FROM assets WHERE owner_id = ? AND kind = 'generated'",
      )
      .all(proj.json.id) as { path: string }[];
    assert.deepEqual(
      rows.map((r) => r.path),
      [winnerFile],
    );
    // the losing attempt removed its own download only
    assert.equal(existsSync(winnerFile), true);
    assert.equal(existsSync(loserFile), false);
    // the winner's file still serves its bytes
    const fres = await fetch(`${b}/api/assets/${jWin.output_asset_id}/file`);
    assert.equal(fres.status, 200);
    assert.deepEqual(
      Buffer.from(await fres.arrayBuffer()),
      Buffer.from(TINY_PNG_B64, "base64"),
    );
  } finally {
    srv.close();
  }
});

test("raced polls: a failed result arriving after commit keeps succeeded", async () => {
  const { proj, rec, outDir } = await seedRacedGeneration("race-fail");
  const gated = new GatedPollBackend(outDir);
  const { srv, b } = await serveWith(gated);
  try {
    const p1 = fetch(`${b}/api/generations/${rec.id}`).then((r) => ({
      tag: 1,
      r,
    }));
    const p2 = fetch(`${b}/api/generations/${rec.id}`).then((r) => ({
      tag: 2,
      r,
    }));
    await waitUntil(
      () => gated.pending.length === 2,
      "both downloads to reach the pre-commit gate",
    );
    const winnerFile = gated.pending[0].file;
    const loserFile = gated.pending[1].file;
    gated.pending[0].release();
    const win = await Promise.race([p1, p2]);
    const jWin = await win.r.json();
    assert.equal(jWin.status, "succeeded");
    // the slower attempt reports a backend failure AFTER the win —
    // still handing over the file it staged so it can be cleaned
    gated.pending[1].release({
      status: "failed",
      error: "late backend failure",
      output_files: [gated.pending[1].file],
    });
    const jLose = await (await (win.tag === 1 ? p2 : p1)).r.json();
    assert.equal(
      jLose.status,
      "succeeded",
      "a late failure must not revert a committed success",
    );
    assert.equal(jLose.output_asset_id, jWin.output_asset_id);
    assert.equal(existsSync(winnerFile), true);
    assert.equal(existsSync(loserFile), false);
    assert.equal(getGeneration(db, rec.id).status, "succeeded");
  } finally {
    srv.close();
  }
});

test("a failed poll result still cleans the files it staged", async () => {
  const { rec, outDir } = await seedRacedGeneration("fail-cleans");
  const gated = new GatedPollBackend(outDir);
  const { srv, b } = await serveWith(gated);
  try {
    const p1 = fetch(`${b}/api/generations/${rec.id}`);
    await waitUntil(() => gated.pending.length === 1, "the download");
    const staged = gated.pending[0].file;
    gated.pending[0].release({
      status: "failed",
      error: "backend blew up after download",
      output_files: [staged],
    });
    const j = await (await p1).json();
    assert.equal(j.status, "failed");
    assert.equal(
      existsSync(staged),
      false,
      "files staged by a failed attempt must be removed",
    );
  } finally {
    srv.close();
  }
});

test("poll failure recovery: keeps a committed success; marks a live record failed", async () => {
  // imported lazily so this test alone fails while the export is missing
  const { markPollFailed } = await import("../src/http/handlers.ts");
  const proj = transact(db, () => createProject(db, "poll-recovery"));
  const outDir = join(config.assets_root, proj.id);
  mkdirSync(outDir, { recursive: true });
  const winner = join(outDir, "winner.png");
  const loser = join(outDir, "loser.png");
  writeFileSync(winner, Buffer.from(TINY_PNG_B64, "base64"));
  writeFileSync(loser, Buffer.from(TINY_PNG_B64, "base64"));
  const asset = transact(db, () =>
    insertAsset(db, {
      owner_kind: "project",
      owner_id: proj.id,
      kind: "generated",
      path: winner,
    }),
  );
  const won = transact(db, () =>
    insertGeneration(db, {
      project_id: proj.id,
      kind: "image",
      inputs: "{}",
      backend: "gated-poll",
    }),
  );
  transact(db, () =>
    updateGenerationStatus(db, {
      id: won.id,
      status: "succeeded",
      output_asset_id: asset.id,
    }),
  );
  // the losing attempt's commit threw; its recovery must neither
  // revert the committed success nor delete the registered file
  markPollFailed(db, won.id, [loser], new Error("registration blew up"));
  const after = getGeneration(db, won.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.output_asset_id, asset.id);
  assert.equal(existsSync(winner), true);
  assert.equal(existsSync(loser), false);

  // while still running, the same recovery marks failed and cleans up
  const live = transact(db, () =>
    insertGeneration(db, {
      project_id: proj.id,
      kind: "image",
      inputs: "{}",
      backend: "gated-poll",
    }),
  );
  const staged = join(outDir, "staged.png");
  writeFileSync(staged, Buffer.from(TINY_PNG_B64, "base64"));
  transact(db, () =>
    updateGenerationStatus(db, { id: live.id, status: "running" }),
  );
  markPollFailed(db, live.id, [staged], new Error("registration blew up"));
  assert.equal(getGeneration(db, live.id).status, "failed");
  assert.equal(existsSync(staged), false);
});

test("comfy poll stages each attempt under a unique name inside the root", async () => {
  const backend = new ComfySdkBackend(
    {
      base: {
        file: "missing-workflow.json",
        prompt_node: "1",
        output_node: "9",
      },
    },
    config.assets_root,
  );
  const proj = transact(db, () => createProject(db, "comfy-stage"));
  const written: string[] = [];
  const fakeClient = {
    jobs: {
      get: async () => ({
        status: "completed",
        getOutputs: async () => [
          {
            name: "..\\remote-name.png",
            toFile: async (p: string) => {
              writeFileSync(p, Buffer.from(TINY_PNG_B64, "base64"));
              written.push(p);
            },
          },
        ],
      }),
    },
  };
  // inject the SDK client the backend lazily creates
  (backend as unknown as { clientPromise: Promise<unknown> }).clientPromise =
    Promise.resolve(fakeClient);
  const job = { backend_job_id: "job-1" };
  const ctx = { project_id: proj.id, generation_id: "gen-race" };
  const r1 = await backend.poll(job, ctx);
  const r2 = await backend.poll(job, ctx);
  try {
    assert.equal(r1.status, "succeeded");
    assert.equal(r2.status, "succeeded");
    const f1 = (r1.output_files ?? [])[0];
    const f2 = (r2.output_files ?? [])[0];
    assert.notEqual(
      f1,
      f2,
      "two poll attempts of the same job must not stage to the same path",
    );
    assert.equal(isUnder(config.assets_root, f1), true);
    assert.equal(isUnder(config.assets_root, f2), true);
    assert.match(
      basename(f1),
      /^gen-race-[0-9a-f-]{36}-0-remote-name\.png$/,
    );
    assert.equal(existsSync(f1), true);
    assert.equal(existsSync(f2), true);
  } finally {
    for (const f of written) rmSync(f, { force: true });
  }
});

test("comfy backend rejects multi-ref input before contacting the client", async () => {
  const backend = new ComfySdkBackend(
    {
      base: { file: "missing-workflow.json", prompt_node: "1", output_node: "9" },
    },
    config.assets_root,
  );
  await assert.rejects(
    backend.submit(
      {
        kind: "image",
        prompt: "p",
        ref_images: ["a.png", "b.png"],
        settings: {},
        resolved_refs: {
          blueprint_version_id: "bv",
          item_revision_ids: [],
          character_revision_ids: [],
          base_image_asset_ids: ["a", "b"],
          ref_image_asset_ids: ["a", "b"],
          asset_ids: [],
          used_asset_ids: [],
        },
      },
      { project_id: "p", generation_id: "g" },
    ),
    /reference/i,
  );
});
