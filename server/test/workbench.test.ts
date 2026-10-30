import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";
import type { ServerConfig } from "../src/config.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");

let dir: string;
let server: Server;
let base: string;
let db: ReturnType<typeof openDatabase>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "vo-workbench-"));
  db = openDatabase(join(dir, "app.db"));
  migrate(db, MIGRATIONS);
  const config: ServerConfig = {
    port: 0,
    data_dir: dir,
    db_path: join(dir, "app.db"),
    assets_root: join(dir, "assets"),
    llm_provider: "mock",
    gen_backend: "mock",
    workflow_file: "",
    max_body_bytes: 32 * 1024 * 1024,
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

const newProject = async (name: string) => {
  const res = await api("POST", "/api/projects", { name });
  assert.equal(res.status, 201);
  return res.json.id as string;
};

test("workbench background: save → project state restores; unlock overwrites stale row", async () => {
  const pid = await newProject("bg-basic");

  const before0 = await api("GET", `/api/projects/${pid}/state`);
  assert.equal(before0.json.workbench_background, null);

  const saved = await api("PUT", `/api/projects/${pid}/workbench/background`, {
    backdrop_key: "studio",
    locked: true,
    expected_version: null,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.backdrop_key, "studio");
  assert.equal(saved.json.locked, true);
  assert.equal(saved.json.workbench_version, 1);

  const state = await api("GET", `/api/projects/${pid}/state`);
  assert.equal(state.json.workbench_background.backdrop_key, "studio");
  assert.equal(state.json.workbench_background.locked, true);

  // unlocking + changing the selection replaces the row — no stale
  // values survive; the version counter advances
  const unlocked = await api(
    "PUT",
    `/api/projects/${pid}/workbench/background`,
    { backdrop_key: "library", locked: false, expected_version: 1 },
  );
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.json.workbench_version, 2);
  const state2 = await api("GET", `/api/projects/${pid}/state`);
  assert.equal(state2.json.workbench_background.backdrop_key, "library");
  assert.equal(state2.json.workbench_background.locked, false);
});

test("workbench background: stale expected_version → 409, nothing written", async () => {
  const pid = await newProject("bg-conflict");
  const first = await api("PUT", `/api/projects/${pid}/workbench/background`, {
    backdrop_key: "rain",
    locked: true,
    expected_version: null,
  });
  assert.equal(first.status, 200);

  // a second writer advances the row to version 2
  const second = await api(
    "PUT",
    `/api/projects/${pid}/workbench/background`,
    { backdrop_key: "studio", locked: true, expected_version: 1 },
  );
  assert.equal(second.status, 200);

  // a screen still holding version 1 loses — nothing is overwritten
  const stale = await api(
    "PUT",
    `/api/projects/${pid}/workbench/background`,
    { backdrop_key: "library", locked: false, expected_version: 1 },
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "conflict");
  const state = await api("GET", `/api/projects/${pid}/state`);
  assert.equal(state.json.workbench_background.backdrop_key, "studio");

  // a nonexistent-row expectation is also a conflict once a row exists
  const blind = await api(
    "PUT",
    `/api/projects/${pid}/workbench/background`,
    { backdrop_key: "rain", locked: false, expected_version: null },
  );
  assert.equal(blind.status, 409);
});

test("workbench background: settings are per-project", async () => {
  const p1 = await newProject("bg-a");
  const p2 = await newProject("bg-b");
  await api("PUT", `/api/projects/${p1}/workbench/background`, {
    backdrop_key: "rain",
    locked: true,
    expected_version: null,
  });
  const s2 = await api("GET", `/api/projects/${p2}/state`);
  assert.equal(s2.json.workbench_background, null);
  const s1 = await api("GET", `/api/projects/${p1}/state`);
  assert.equal(s1.json.workbench_background.backdrop_key, "rain");
});

test("workbench background: validation and isolation", async () => {
  const pid = await newProject("bg-validation");
  for (const [body, want] of [
    [{}, 400],
    [{ backdrop_key: "rain" }, 400],
    [{ backdrop_key: "rain", locked: true }, 400],
    [{ backdrop_key: "rain", locked: "yes", expected_version: null }, 400],
    [{ backdrop_key: "spaceship", locked: true, expected_version: null }, 400],
    [
      {
        backdrop_key: "rain",
        locked: true,
        expected_version: null,
        extra: 1,
      },
      400,
    ],
    [
      { backdrop_key: "rain", locked: true, expected_version: "1" },
      400,
    ],
  ] as const) {
    const res = await api(
      "PUT",
      `/api/projects/${pid}/workbench/background`,
      body,
    );
    assert.equal(res.status, want, JSON.stringify(body));
  }
  const ghost = await api("PUT", "/api/projects/nope/workbench/background", {
    backdrop_key: "rain",
    locked: true,
    expected_version: null,
  });
  assert.equal(ghost.status, 404);

  // a settings write creates no generations or blueprints
  await api("PUT", `/api/projects/${pid}/workbench/background`, {
    backdrop_key: "rain",
    locked: true,
    expected_version: null,
  });
  const state = await api("GET", `/api/projects/${pid}/state`);
  assert.equal(state.json.generations.length, 0);
  assert.equal(state.json.blueprint_versions.length, 0);
});
