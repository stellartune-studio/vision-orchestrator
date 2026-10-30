import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertMockEndpoints,
  checkScratchDbFile,
  verifyEntitiesInDb,
  stateFingerprint,
  diffState,
  fetchProjectState,
  saveManifest,
  loadManifest,
} from "../../scripts/ui-verify/scene-draft/common.mjs";

// ------------------------------------------------------------------
// Mock-only gate: exercised against LOCAL fake HTTP servers only —
// never a real provider. Each fake counts the write (non-GET) requests
// it receives; a refused gate must produce exactly zero.
// ------------------------------------------------------------------
const MOCK_META = { mock: true, llm_provider: "mock", gen_backend: "mock" };
const REAL_META = { mock: false, llm_provider: "real", gen_backend: "comfy" };

const fakeServer = async (
  handler: (req: any, res: any) => void,
): Promise<{ url: string; writes: () => number; close: () => void }> => {
  let writeCount = 0;
  const srv: Server = createServer((req, res) => {
    if (req.method !== "GET") writeCount++;
    handler(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    writes: () => writeCount,
    close: () => srv.close(),
  };
};
const metaReply = (body: any) => (_req: any, res: any) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const completeManifest = (zeta: any = { created: false, reason: "scratch DB omitted" }) => ({
  run_id: "r1",
  projects: {
    alpha: { name: "alpha-r1", project_id: "p-alpha" },
    beta: { name: "beta-r1", project_id: "p-beta" },
    gamma: { name: "gamma-r1", project_id: "p-gamma" },
    delta: { name: "delta-r1", project_id: "p-delta" },
    epsilon: { name: "epsilon-r1", project_id: "p-epsilon" },
    zeta,
  },
});

test("mock gate: both endpoints mock → ok", async () => {
  const a = await fakeServer(metaReply(MOCK_META));
  const w = await fakeServer(metaReply(MOCK_META));
  try {
    const r = await assertMockEndpoints({ api: a.url, web: w.url });
    assert.equal(r.ok, true);
  } finally {
    a.close();
    w.close();
  }
});

test("mock gate: non-mock on EITHER endpoint refuses, 0 writes", async () => {
  const mock = await fakeServer(metaReply(MOCK_META));
  const real = await fakeServer(metaReply(REAL_META));
  try {
    // API side real, web side mock
    let r = await assertMockEndpoints({ api: real.url, web: mock.url });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.includes("VO_API")));
    // web side real, API side mock
    r = await assertMockEndpoints({ api: mock.url, web: real.url });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.includes("VO_WEB")));
    // a refused gate issues no write requests to either endpoint
    assert.equal(mock.writes(), 0);
    assert.equal(real.writes(), 0);
  } finally {
    mock.close();
    real.close();
  }
});

test("mock gate: unreachable / malformed meta refuses", async () => {
  const bad = await fakeServer((_req, res) => {
    res.end("not json");
  });
  try {
    const r = await assertMockEndpoints({
      api: "http://127.0.0.1:1", // nothing listens here
      web: bad.url,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 2);
    assert.equal(bad.writes(), 0);
  } finally {
    bad.close();
  }
});

// ------------------------------------------------------------------
// Scratch-DB guard — dummy dirs and dummy DBs only; the real data dir
// is never touched.
// ------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "vo-scratchdb-test-"));
const fakeProdDir = join(root, "repo", "data");
mkdirSync(fakeProdDir, { recursive: true });
const scratchDir = join(root, "scratch");
mkdirSync(scratchDir, { recursive: true });

const mkDb = (path: string) => {
  const db = new DatabaseSync(path);
  for (const t of [
    "projects",
    "production_documents",
    "document_revisions",
    "blueprint_versions",
    "characters",
  ]) {
    db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`);
  }
  return db;
};

test("scratch DB guard: existing db in an explicit scratch dir → ok", () => {
  const p = join(scratchDir, "app.db");
  mkDb(p).close();
  const r = checkScratchDbFile(p, fakeProdDir);
  assert.equal(r.ok, true);
});

test("scratch DB guard: nonexistent file refused — never created", () => {
  const p = join(scratchDir, "does-not-exist.db");
  const r = checkScratchDbFile(p, fakeProdDir);
  assert.equal(r.ok, false);
  assert.ok(!existsSync(p), "must not create an empty DB");
});

test("scratch DB guard: normal data location refused", () => {
  const prodDb = join(fakeProdDir, "app.db");
  mkDb(prodDb).close();
  const r = checkScratchDbFile(prodDb, fakeProdDir);
  assert.equal(r.ok, false);
  assert.equal(checkScratchDbFile(fakeProdDir, fakeProdDir).ok, false);
  assert.equal(checkScratchDbFile(undefined, fakeProdDir).ok, false);
});

test("scratch DB guard: entity cross-check via read-only connection", () => {
  const p = join(scratchDir, "fixture.db");
  const db = mkDb(p);
  db.prepare("INSERT INTO projects (id) VALUES (?)").run("p-this-run");
  db.close();
  const ok = verifyEntitiesInDb(p, {
    projects: ["p-this-run"],
    documents: [],
    revisions: [],
    blueprintVersions: [],
    characters: [],
  });
  assert.equal(ok.ok, true);
  const bad = verifyEntitiesInDb(p, {
    projects: ["p-other-run"],
    documents: [],
    revisions: [],
    blueprintVersions: [],
    characters: [],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.some((m) => m.includes("p-other-run")));
});

// ------------------------------------------------------------------
// Manifest round-trip
// ------------------------------------------------------------------
test("manifest: save/load round-trip; malformed refuses", () => {
  const p = join(scratchDir, "manifest.json");
  saveManifest(completeManifest(), p);
  const m = loadManifest(p);
  assert.equal(m.run_id, "r1");
  assert.equal(m.projects.alpha.name, "alpha-r1");
  writeFileSync(join(scratchDir, "bad.json"), "{}");
  assert.throws(() => loadManifest(join(scratchDir, "bad.json")));
  assert.throws(() => loadManifest(join(scratchDir, "missing.json")));
});

test("manifest: only explicitly absent zeta with a reason may be skipped", () => {
  for (const zeta of [undefined, {}, { created: "false", reason: "none" },
    { created: false, reason: "  " }, { created: true, name: "z", project_id: "p" }]) {
    const p = join(scratchDir, `manifest-invalid-${Math.random()}.json`);
    const m = completeManifest(zeta);
    if (zeta === undefined) delete m.projects.zeta;
    saveManifest(m, p);
    assert.throws(() => loadManifest(p));
  }
  const created = completeManifest({
    created: true, name: "zeta-r1", project_id: "p-zeta",
    blueprint_version_id: "bv-zeta",
    docs: { script: { document_id: "d-zeta", revision_id: "r-zeta" } },
  });
  const p = join(scratchDir, "manifest-zeta-created.json");
  saveManifest(created, p);
  assert.equal(loadManifest(p).projects.zeta.created, true);
});

// ------------------------------------------------------------------
// Non-mutation diff — the comparator must actually DETECT changes to
// adopted revisions, revision contents and generation records.
// ------------------------------------------------------------------
const baseState = (): any => ({
  documents: [
    {
      id: "d1",
      adopted_revision_id: "r2",
      state_version: 2,
      revisions: [
        { id: "r1", rev_no: 1, content: "場面: 元の本文", proposal_status: "superseded" },
        {
          id: "r2",
          rev_no: 2,
          content: "場面: 採用本文",
          proposal_status: "adopted",
          blueprint_version_id: "bv1",
          base_revision_id: "r1",
          instruction_message_id: null,
        },
      ],
      pending_proposals: [],
    },
  ],
  generations: [
    {
      id: "g1", project_id: "p1", kind: "image", status: "queued",
      blueprint_version_id: "bv1", document_revision_id: "r2",
      inputs: "{\"prompt\":\"scene\"}", backend: "mock",
      backend_job_id: null, output_asset_id: null, error: null,
      created_at: "2026-01-01", updated_at: "2026-01-01",
    },
  ],
  amendment_outcomes: [
    {
      id: "o1", project_id: "p1", instruction_message_id: "m1",
      assistant_message_id: "m2", document_id: "d1", base_revision_id: "r1",
      blueprint_version_id: "bv1", outcome: "saved", result_revision_id: "r2",
      reject_reason: null, created_at: "2026-01-01",
    },
  ],
});

test("state diff: identical snapshots produce no diffs", () => {
  const a = stateFingerprint(baseState());
  assert.deepEqual(diffState(a, stateFingerprint(baseState())), []);
});

test("state diff: detects symmetric saved-state changes and ignores returned row order", () => {
  const before = stateFingerprint(baseState());

  const adoptFlip = baseState();
  adoptFlip.documents[0].adopted_revision_id = "r9";
  assert.ok(
    diffState(before, stateFingerprint(adoptFlip)).some((d) =>
      d.includes("adopted_revision_id"),
    ),
  );

  const contentEdit = baseState();
  contentEdit.documents[0].revisions[1].content = "書き換え";
  assert.ok(
    diffState(before, stateFingerprint(contentEdit)).some((d) =>
      d.includes("revision changed"),
    ),
  );

  const newRev = baseState();
  newRev.documents[0].revisions.push({
    id: "r3",
    rev_no: 3,
    content: "新しい版",
    proposal_status: "pending",
  } as any);
  assert.ok(
    diffState(before, stateFingerprint(newRev)).some((d) =>
      d.includes("revision added"),
    ),
  );

  const newGen = baseState();
  newGen.generations.push({ ...newGen.generations[0], id: "g2" });
  assert.ok(
    diffState(before, stateFingerprint(newGen)).some((d) =>
      d.includes("generation added"),
    ),
  );

  for (const [field, value] of [["status", "failed"], ["inputs", "changed"],
    ["output_asset_id", "asset-new"]] as const) {
    const changed = baseState();
    changed.generations[0][field] = value as never;
    assert.ok(diffState(before, stateFingerprint(changed)).some((d) =>
      d.includes("generation changed: g1"),
    ), `${field} change detected`);
  }
  const removedGen = baseState();
  removedGen.generations = [];
  assert.ok(diffState(before, stateFingerprint(removedGen)).some((d) =>
    d.includes("generation removed: g1"),
  ));

  const newOutcome = baseState();
  newOutcome.amendment_outcomes.push({ ...newOutcome.amendment_outcomes[0], id: "o2" });
  assert.ok(
    diffState(before, stateFingerprint(newOutcome)).some((d) =>
      d.includes("amendment outcome added"),
    ),
  );
  const changedOutcome = baseState();
  changedOutcome.amendment_outcomes[0].reject_reason = "refused";
  assert.ok(diffState(before, stateFingerprint(changedOutcome)).some((d) =>
    d.includes("amendment outcome changed: o1"),
  ));
  const removedOutcome = baseState();
  removedOutcome.amendment_outcomes = [];
  assert.ok(diffState(before, stateFingerprint(removedOutcome)).some((d) =>
    d.includes("amendment outcome removed: o1"),
  ));

  const reordered = baseState();
  reordered.documents[0].revisions.reverse();
  reordered.generations.reverse();
  reordered.amendment_outcomes.reverse();
  assert.deepEqual(diffState(before, stateFingerprint(reordered)), []);
});

test("state fetch: rejects HTTP errors, malformed shape, and another project", async () => {
  const complete = {
    project: { id: "p1" }, documents: [], generations: [], amendment_outcomes: [],
  };
  for (const [status, body] of [
    [500, JSON.stringify(complete)],
    [200, "not json"],
    [200, JSON.stringify({ ...complete, project: { id: "p2" } })],
    [200, JSON.stringify({ ...complete, generations: undefined })],
  ] as const) {
    const server = await fakeServer((_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
    try {
      await assert.rejects(fetchProjectState(server.url, "p1"));
    } finally {
      server.close();
    }
  }
  const okServer = await fakeServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(complete));
  });
  try {
    assert.deepEqual(await fetchProjectState(okServer.url, "p1"), complete);
  } finally {
    okServer.close();
  }
});

after(() => rmSync(root, { recursive: true, force: true }));
