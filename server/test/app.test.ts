import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GenerationRejectedError } from "../src/gen/backend.ts";
import type { GenerationJob } from "../src/gen/backend.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import { MockGenerationBackend } from "../src/gen/mockBackend.ts";
import { adoptDocumentRevision } from "../src/repos/documents.ts";
import type { DocAmendInput, DirectorInput } from "../src/llm/provider.ts";
import type { ServerConfig } from "../src/config.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");

/**
 * Controllable mock for amend-path tests: captures the exact input the
 * route built (fixed-context verification), can be told to fail or
 * return a malformed amendment, and can run a hook mid-call to
 * simulate an adoption landing while the request was in flight.
 */
class TestDirectorProvider extends MockDirectorProvider {
  lastAmendInput: DocAmendInput | null = null;
  amendError: Error | null = null;
  amendOverride: unknown;
  /** every provider call (converse + reviseDocument) lands here so a
   *  test can prove a code path made ZERO LLM calls */
  llmCalls = 0;
  /** full output override — reply-only turns, unparseable blocks */
  amendOutput: {
    reply?: string;
    amendment?: unknown;
    amendment_error?: string;
  } | null = null;
  onAmend: (() => void) | null = null;

  async converse(input: DirectorInput) {
    this.llmCalls++;
    return super.converse(input);
  }

  async reviseDocument(input: DocAmendInput) {
    this.llmCalls++;
    this.lastAmendInput = input;
    this.onAmend?.();
    if (this.amendError) throw this.amendError;
    const out = await super.reviseDocument(input);
    if (this.amendOutput) return { ...out, ...this.amendOutput };
    if (this.amendOverride !== undefined) {
      return { reply: out.reply, amendment: this.amendOverride };
    }
    return out;
  }

  reset() {
    this.lastAmendInput = null;
    this.amendError = null;
    this.amendOverride = undefined;
    this.amendOutput = null;
    this.onAmend = null;
  }
}

let dir: string;
let server: Server;
let base: string;
let db: ReturnType<typeof openDatabase>;
let llm: TestDirectorProvider;
let genSubmits = 0;
let gen: MockGenerationBackend;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "vo-e2e-"));
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
  llm = new TestDirectorProvider();
  gen = new MockGenerationBackend(config.assets_root);
  const origSubmit = gen.submit.bind(gen);
  gen.submit = (...args) => {
    genSubmits++;
    return origSubmit(...args);
  };
  const router = buildRouter({
    db,
    config,
    llm,
    gen,
  });
  server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  db.close();
  // Windows can hold the WAL handles briefly after close — retry.
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

test("e2e mock: consult → propose → approve → save → generate", async () => {
  // meta reports mock integrations
  const meta = await api("GET", "/api/meta");
  assert.equal(meta.json.mock, true);
  assert.equal(meta.json.llm_provider, "mock");

  // create project — common items already seeded as undecided
  const proj = await api("POST", "/api/projects", { name: "e2e" });
  assert.equal(proj.status, 201);
  const pid = proj.json.id;

  let state = (await api("GET", `/api/projects/${pid}/state`)).json;
  assert.equal(state.items.length, 7);
  assert.ok(
    state.items.some((i: any) => i.kind === "camera_work"),
    "camera_work item is seeded as an optional common item",
  );
  assert.ok(state.items.every((i: any) => i.adoption === "undecided"));

  // consult the director (mock)
  const msg = await api("POST", `/api/projects/${pid}/messages`, {
    content: "物語の映像を作りたい",
  });
  assert.equal(msg.status, 200);
  assert.ok(msg.json.proposals.length >= 1);
  assert.ok(msg.json.reply.includes("proposals"));

  // proposals are saved as UNCONFIRMED — nothing is adopted yet
  state = (await api("GET", `/api/projects/${pid}/state`)).json;
  const purpose = state.items.find((i: any) => i.kind === "purpose");
  assert.equal(purpose.adoption, "proposed_only");
  assert.ok(purpose.pending_proposals.length >= 1);

  // approve the purpose proposal with the correct expected_version
  const purposeRev = purpose.pending_proposals[0];
  const adopt = await api("POST", `/api/items/${purpose.id}/adopt`, {
    revision_id: purposeRev.id,
    expected_version: purpose.state_version,
  });
  assert.equal(adopt.status, 200);
  assert.equal(adopt.json.adopted_revision_id, purposeRev.id);

  // adopting a narrative purpose applies the template: story segments
  // appear as new undecided items
  state = (await api("GET", `/api/projects/${pid}/state`)).json;
  const segments = state.items.filter((i: any) => i.kind === "story_segment");
  assert.ok(segments.length >= 3);
  assert.equal(state.project.template_key, "narrative");

  // conflicting adopt with a stale version → 409
  const intent = state.items.find((i: any) => i.kind === "intent");
  const userRev = await api("POST", `/api/items/${intent.id}/revisions`, {
    content: "静かな余韻を残す",
  });
  assert.equal(userRev.status, 201);
  const conflict = await api("POST", `/api/items/${intent.id}/adopt`, {
    revision_id: userRev.json.id,
    expected_version: 999,
  });
  assert.equal(conflict.status, 409);
  const ok = await api("POST", `/api/items/${intent.id}/adopt`, {
    revision_id: userRev.json.id,
    expected_version: intent.state_version,
  });
  assert.equal(ok.status, 200);

  // adopt output_policy too (required for the production gate)
  const policy = state.items.find((i: any) => i.kind === "output_policy");
  const polRev = await api("POST", `/api/items/${policy.id}/revisions`, {
    content: "16:9、約30秒、動画サイト公開",
  });
  const okPolicy = await api("POST", `/api/items/${policy.id}/adopt`, {
    revision_id: polRev.json.id,
    expected_version: policy.state_version,
  });
  assert.equal(okPolicy.status, 200);

  // freeze a blueprint version
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {
    note: "v1",
  });
  assert.equal(bv.status, 201);
  const bvList = await api("GET", `/api/projects/${pid}/blueprint-versions`);
  assert.equal(bvList.status, 200);
  assert.ok(bvList.json.some((version: any) => version.id === bv.json.id));
  const bvDetail = await api("GET", `/api/blueprint-versions/${bv.json.id}`);
  const snapshotKinds = bvDetail.json.items.map((i: any) => i.kind);
  assert.ok(snapshotKinds.includes("purpose"));
  assert.ok(snapshotKinds.includes("intent"));
  assert.ok(snapshotKinds.includes("output_policy"));

  // draft a script from the blueprint version, then approve it
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
    title: "script v1",
  });
  assert.equal(doc.status, 201);
  assert.equal(doc.json.revision.blueprint_version_id, bv.json.id);

  const docState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script = docState.documents.find(
    (d: any) => d.id === doc.json.document.id,
  );
  const docAdopt = await api("POST", `/api/documents/${script.id}/adopt`, {
    revision_id: script.pending_proposals[0].id,
    expected_version: script.state_version,
  });
  assert.equal(docAdopt.status, 200);

  // production generation: gate passes → mock backend writes a stub
  // image and the record carries the full input snapshot
  const genRes = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
  });
  assert.equal(genRes.status, 200);
  assert.equal(genRes.json.status, "succeeded");
  const inputs = JSON.parse(genRes.json.inputs);
  assert.ok(inputs.prompt.includes("静かな余韻"));
  assert.ok(inputs.resolved_refs.item_revision_ids.includes(userRev.json.id));
  assert.ok(genRes.json.output_asset_id);

  // ST6: the registered generated asset carries a sha256 like uploads do
  const assetState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const out = assetState.assets.find(
    (a: any) => a.id === genRes.json.output_asset_id,
  );
  assert.match(out.sha256, /^[a-f0-9]{64}$/);
  // ST6: the stored sha256 equals the actual file bytes
  const fileHash = createHash("sha256")
    .update(readFileSync(out.path))
    .digest("hex");
  assert.equal(out.sha256, fileHash);

  // the list summary exposes the saved output for its thumbnail
  const listed = (await api("GET", "/api/projects")).json.find(
    (p: any) => p.id === pid,
  );
  assert.equal(
    listed.summary.latest_output_asset_id,
    genRes.json.output_asset_id,
  );
  assert.equal(listed.summary.latest_output_kind, "image");
});

test("project list carries compact per-project summaries", async () => {
  const proj = await api("POST", "/api/projects", { name: "summary" });
  assert.equal(proj.status, 201);
  // the create response carries the same summary shape as the list
  assert.deepEqual(proj.json.summary, {
    adopted_items: 0,
    pending_proposals: 0,
    latest_version_no: null,
    latest_generation: null,
    latest_output_asset_id: null,
    latest_output_kind: null,
  });
  const pid = proj.json.id;

  const state = (await api("GET", `/api/projects/${pid}/state`)).json;
  const intent = state.items.find((i: any) => i.kind === "intent");
  const rev = await api("POST", `/api/items/${intent.id}/revisions`, {
    content: "採用する内容",
  });
  await api("POST", `/api/items/${intent.id}/adopt`, {
    revision_id: rev.json.id,
    expected_version: intent.state_version,
  });
  // one pending proposal left unconfirmed on another item
  const purpose = state.items.find((i: any) => i.kind === "purpose");
  await api("POST", `/api/items/${purpose.id}/revisions`, {
    content: "未確認の提案",
  });
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});

  const list = (await api("GET", "/api/projects")).json;
  const row = list.find((p: any) => p.id === pid);
  assert.equal(row.summary.adopted_items, 1);
  assert.equal(row.summary.pending_proposals, 1);
  assert.equal(row.summary.latest_version_no, bv.json.version_no);
  assert.equal(row.summary.latest_generation, null);
});

test("revise → adopt → generate: edited script and materials reach the input", async () => {
  const proj = await api("POST", "/api/projects", { name: "revise" });
  const pid = proj.json.id;
  const state0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const [kind, content] of [
    ["intent", "静かな余韻を残す"],
    ["output_policy", "16:9、約30秒、動画サイト公開"],
  ]) {
    const item = state0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content,
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  }

  // pin a character revision so it is frozen into the snapshot
  const char = await api("POST", "/api/characters", { name: "ミオ" });
  const crev1 = await api("POST", `/api/characters/${char.json.id}/revisions`, {
    profile: {
      appearance: "short black bob",
      traits: { locked: { hair: "bob" } },
    },
  });
  await api("PUT", `/api/projects/${pid}/characters`, {
    character_id: char.json.id,
    character_revision_id: crev1.json.id,
    expected_version: null,
  });

  // a text material selected into the snapshot
  const textAsset = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "material",
    name: "palette.txt",
    mime: "text/plain",
    content_base64: Buffer.from("配色: 藍と金").toString("base64"),
  });
  assert.equal(textAsset.status, 201);
  await api("POST", `/api/assets/${textAsset.json.id}/select`, {
    selected: true, expected_version: 0,
  });

  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  assert.equal(doc.status, 201);
  const draftRev = doc.json.revision;

  // the director edits the draft — the new revision inherits the
  // blueprint link of the revision it was based on
  const edit = await api(
    "POST",
    `/api/documents/${doc.json.document.id}/revisions`,
    {
      content: "最後は振り返らず、背中だけを見せる",
      base_revision_id: draftRev.id,
    },
  );
  assert.equal(edit.status, 201);
  assert.equal(edit.json.blueprint_version_id, bv.json.id);

  // approve the EDITED revision (the mock draft is superseded)
  const docState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script = docState.documents.find(
    (d: any) => d.id === doc.json.document.id,
  );
  const adopt = await api("POST", `/api/documents/${script.id}/adopt`, {
    revision_id: edit.json.id,
    expected_version: script.state_version,
  });
  assert.equal(adopt.status, 200);

  // the approved doc is in sync with the blueprint it came from
  let st = (await api("GET", `/api/projects/${pid}/state`)).json;
  let view = st.documents.find((d: any) => d.id === script.id);
  assert.equal(view.adoption, "adopted");
  assert.equal(view.consistency, "in_sync");

  // a further edit without base_revision_id inherits the adopted
  // revision's blueprint link (not lost)
  const edit2 = await api("POST", `/api/documents/${script.id}/revisions`, {
    content: "another pass",
  });
  assert.equal(edit2.json.blueprint_version_id, bv.json.id);

  // the gate accepts the edited revision and its content reaches the
  // backend input — the mock draft's text does NOT
  const gen = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
  });
  assert.equal(gen.status, 200);
  const inputs = JSON.parse(gen.json.inputs);
  assert.ok(inputs.prompt.includes("最後は振り返らず、背中だけを見せる"));
  assert.ok(!inputs.prompt.includes("モック応答"));
  assert.ok(inputs.prompt.includes("配色: 藍と金")); // text material inlined
  assert.ok(inputs.prompt.includes("short black bob")); // pinned profile
  assert.equal(inputs.resolved_refs.document_revision_id, edit.json.id);
  // every selected material was actually consumed — nothing dropped
  assert.deepEqual(
    inputs.resolved_refs.used_asset_ids.sort(),
    inputs.resolved_refs.asset_ids.sort(),
  );

  // re-pinning the character to a different revision flags the
  // approved doc needs_recheck — approval itself is NOT revoked
  const crev2 = await api("POST", `/api/characters/${char.json.id}/revisions`, {
    profile: { appearance: "long silver hair" },
  });
  await api("PUT", `/api/projects/${pid}/characters`, {
    character_id: char.json.id,
    character_revision_id: crev2.json.id,
    expected_version: 1,
  });
  st = (await api("GET", `/api/projects/${pid}/state`)).json;
  view = st.documents.find((d: any) => d.id === script.id);
  assert.equal(view.consistency, "needs_recheck");
  assert.equal(view.adoption, "adopted");

  // pinning back restores in_sync — the flag tracks real drift
  await api("PUT", `/api/projects/${pid}/characters`, {
    character_id: char.json.id,
    character_revision_id: crev1.json.id,
    expected_version: 2,
  });
  st = (await api("GET", `/api/projects/${pid}/state`)).json;
  view = st.documents.find((d: any) => d.id === script.id);
  assert.equal(view.consistency, "in_sync");

  // deselecting a snapshotted asset flags recheck on its own
  await api("POST", `/api/assets/${textAsset.json.id}/select`, {
    selected: false, expected_version: 1,
  });
  st = (await api("GET", `/api/projects/${pid}/state`)).json;
  view = st.documents.find((d: any) => d.id === script.id);
  assert.equal(view.consistency, "needs_recheck");
});

test("unusable selected material: generation is rejected, not silently dropped", async () => {
  const proj = await api("POST", "/api/projects", { name: "unusable" });
  const pid = proj.json.id;
  const state0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = state0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content: "x",
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  }
  // a video material — no generation input can express it
  const mp4 = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "material",
    name: "clip.mp4",
    mime: "video/mp4",
    content_base64: Buffer.from([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0,
    ]).toString("base64"),
  });
  assert.equal(mp4.status, 201);
  await api("POST", `/api/assets/${mp4.json.id}/select`, { selected: true, expected_version: 0 });

  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  const docState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script = docState.documents.find(
    (d: any) => d.id === doc.json.document.id,
  );
  await api("POST", `/api/documents/${script.id}/adopt`, {
    revision_id: script.pending_proposals[0].id,
    expected_version: script.state_version,
  });

  const gen = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
  });
  assert.equal(gen.status, 422);
  assert.ok(gen.json.error.includes(mp4.json.id));
});

test("generation with multiple approved docs: explicit selection required and used", async () => {
  const proj = await api("POST", "/api/projects", { name: "multi-doc" });
  const pid = proj.json.id;
  const state0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = state0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content: "x",
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  }
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});

  // two documents derived from the same version, each edited then
  // approved so their contents are identifiable
  const ids: Record<string, { docId: string; revId: string; text: string }> =
    {};
  for (const [tag, kind, text] of [
    ["script", "script", "第一幕だけの台本"],
    ["board", "storyboard", "絵コンテ: 固定カメラで引き"],
  ] as const) {
    const doc = await api("POST", `/api/projects/${pid}/documents`, {
      kind,
      blueprint_version_id: bv.json.id,
    });
    const edit = await api(
      "POST",
      `/api/documents/${doc.json.document.id}/revisions`,
      { content: text, base_revision_id: doc.json.revision.id },
    );
    const st = (await api("GET", `/api/projects/${pid}/state`)).json;
    const d = st.documents.find((x: any) => x.id === doc.json.document.id);
    await api("POST", `/api/documents/${d.id}/adopt`, {
      revision_id: edit.json.id,
      expected_version: d.state_version,
    });
    ids[tag] = { docId: d.id, revId: edit.json.id, text };
  }

  // omitted → ambiguous, never a silent pick
  const omit = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
  });
  assert.equal(omit.status, 422);
  assert.ok(omit.json.error.includes("document_revision_id"));

  // explicit → exactly that document's body reaches the input
  const gen = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
    document_revision_id: ids.board.revId,
  });
  assert.equal(gen.status, 200);
  const inputs = JSON.parse(gen.json.inputs);
  assert.equal(inputs.resolved_refs.document_revision_id, ids.board.revId);
  assert.ok(inputs.prompt.includes("絵コンテ: 固定カメラで引き"));
  assert.ok(!inputs.prompt.includes("第一幕だけの台本"));

  // a revision that is not the adopted one is refused
  const docState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script = docState.documents.find((d: any) => d.id === ids.script.docId);
  const staleRev = script.revisions.find(
    (r: any) => r.id !== script.adopted_revision_id,
  );
  const bad = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
    document_revision_id: staleRev.id,
  });
  assert.equal(bad.status, 422);
});

test("document revision re-base: same-project switch allowed, foreign blueprint rejected", async () => {
  const proj = await api("POST", "/api/projects", { name: "rebase" });
  const pid = proj.json.id;
  const state0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = state0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content: "x",
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  }
  const bv1 = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv1.json.id,
  });
  const docId = doc.json.document.id;

  // evolve the blueprint, freeze v2
  const st1 = (await api("GET", `/api/projects/${pid}/state`)).json;
  const audience = st1.items.find((i: any) => i.kind === "audience");
  const audRev = await api("POST", `/api/items/${audience.id}/revisions`, {
    content: "ファン層",
  });
  await api("POST", `/api/items/${audience.id}/adopt`, {
    revision_id: audRev.json.id,
    expected_version: audience.state_version,
  });
  const bv2 = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});

  // explicit re-base onto v2 → the revision satisfies v2's gate
  const rebased = await api("POST", `/api/documents/${docId}/revisions`, {
    content: "v2向けに書き直し",
    blueprint_version_id: bv2.json.id,
  });
  assert.equal(rebased.status, 201);
  assert.equal(rebased.json.blueprint_version_id, bv2.json.id);
  const docState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const d = docState.documents.find((x: any) => x.id === docId);
  await api("POST", `/api/documents/${docId}/adopt`, {
    revision_id: rebased.json.id,
    expected_version: d.state_version,
  });
  const gen = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv2.json.id,
    kind: "image",
  });
  assert.equal(gen.status, 200);
  assert.equal(
    JSON.parse(gen.json.inputs).resolved_refs.document_revision_id,
    rebased.json.id,
  );

  // another project's blueprint version is not a re-base target
  const other = await api("POST", "/api/projects", { name: "other" });
  const bvOther = await api(
    "POST",
    `/api/projects/${other.json.id}/blueprint-versions`,
    {},
  );
  const foreign = await api("POST", `/api/documents/${docId}/revisions`, {
    content: "y",
    blueprint_version_id: bvOther.json.id,
  });
  assert.equal(foreign.status, 400);
});

test("base_revision_id from another document is rejected — even with explicit blueprint", async () => {
  const proj = await api("POST", "/api/projects", { name: "base-fk" });
  const pid = proj.json.id;
  const st0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  const item = st0.items.find((i: any) => i.kind === "intent");
  const rev = await api("POST", `/api/items/${item.id}/revisions`, {
    content: "x",
  });
  await api("POST", `/api/items/${item.id}/adopt`, {
    revision_id: rev.json.id,
    expected_version: item.state_version,
  });
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const d1 = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  const d2 = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "storyboard",
    blueprint_version_id: bv.json.id,
  });

  const foreignBase = await api(
    "POST",
    `/api/documents/${d1.json.document.id}/revisions`,
    { content: "x", base_revision_id: d2.json.revision.id },
  );
  assert.equal(foreignBase.status, 400);

  const foreignBaseWithBv = await api(
    "POST",
    `/api/documents/${d1.json.document.id}/revisions`,
    {
      content: "x",
      base_revision_id: d2.json.revision.id,
      blueprint_version_id: bv.json.id,
    },
  );
  assert.equal(foreignBaseWithBv.status, 400);
});

test("text material: >8KiB rejected before generation; Japanese text intact", async () => {
  const proj = await api("POST", "/api/projects", { name: "big-text" });
  const pid = proj.json.id;
  const state0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = state0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content: "x",
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  }
  // あ × 3000 = 9000 bytes UTF-8 — over the 8KiB inline limit
  const big = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "material",
    name: "memo.txt",
    mime: "text/plain",
    content_base64: Buffer.from("あ".repeat(3000)).toString("base64"),
  });
  assert.equal(big.status, 201);
  await api("POST", `/api/assets/${big.json.id}/select`, { selected: true, expected_version: 0 });

  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  const docState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script = docState.documents.find(
    (d: any) => d.id === doc.json.document.id,
  );
  await api("POST", `/api/documents/${script.id}/adopt`, {
    revision_id: script.pending_proposals[0].id,
    expected_version: script.state_version,
  });

  const gen = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
  });
  assert.equal(gen.status, 422);
  assert.ok(gen.json.error.includes(big.json.id));
  assert.ok(gen.json.error.includes("8192"));

  // deselect the oversized one; a within-limit Japanese note goes
  // through byte-for-byte (no mojibake, no truncation marker)
  await api("POST", `/api/assets/${big.json.id}/select`, {
    selected: false, expected_version: 1,
  });
  const noteText = "色指定: 藍 #1a2f5a、余白は広め。夕景の余韻を残す";
  const note = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "material",
    name: "note.txt",
    mime: "text/plain",
    content_base64: Buffer.from(noteText).toString("base64"),
  });
  await api("POST", `/api/assets/${note.json.id}/select`, {
    selected: true, expected_version: 0,
  });
  const bv2 = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc2 = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv2.json.id,
  });
  const st2 = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script2 = st2.documents.find(
    (d: any) => d.id === doc2.json.document.id,
  );
  await api("POST", `/api/documents/${script2.id}/adopt`, {
    revision_id: script2.pending_proposals[0].id,
    expected_version: script2.state_version,
  });
  const gen2 = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv2.json.id,
    kind: "image",
  });
  assert.equal(gen2.status, 200);
  const inputs = JSON.parse(gen2.json.inputs);
  assert.ok(inputs.prompt.includes(noteText));
  assert.ok(!inputs.prompt.includes("truncated"));
});

test("production gate: generation without approved document is 422", async () => {
  const proj = await api("POST", "/api/projects", { name: "gate" });
  const pid = proj.json.id;
  const state = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = state.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content: "x",
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  }
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const genRes = await api("POST", `/api/projects/${pid}/generations`, {
    blueprint_version_id: bv.json.id,
    kind: "image",
  });
  assert.equal(genRes.status, 422);
  assert.ok(genRes.json.error.includes("approved document"));
});

test("document adoption: a superseded revision can still be adopted via API", async () => {
  // Current API contract (documented, not narrowed): the UI only shows
  // 承認する on pending revisions, but adoptDocumentRevision does not
  // reject a superseded one — a re-adoption request it receives is
  // honoured. The UI-hides-it vs domain-forbids-it distinction is
  // deliberate; keep this test as the contract pin.
  const proj = await api("POST", "/api/projects", { name: "sup" });
  const pid = proj.json.id;
  const st0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  const item = st0.items.find((i: any) => i.kind === "intent");
  const rev = await api("POST", `/api/items/${item.id}/revisions`, {
    content: "x",
  });
  await api("POST", `/api/items/${item.id}/adopt`, {
    revision_id: rev.json.id,
    expected_version: item.state_version,
  });
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  const docId = doc.json.document.id;

  // second pending revision; adopting the first supersedes it
  const rev2 = await api("POST", `/api/documents/${docId}/revisions`, {
    content: "修正",
    base_revision_id: doc.json.revision.id,
  });
  let st = (await api("GET", `/api/projects/${pid}/state`)).json;
  let view = st.documents.find((d: any) => d.id === docId);
  await api("POST", `/api/documents/${docId}/adopt`, {
    revision_id: doc.json.revision.id,
    expected_version: view.state_version,
  });
  st = (await api("GET", `/api/projects/${pid}/state`)).json;
  view = st.documents.find((d: any) => d.id === docId);
  const superseded = view.revisions.find((r: any) => r.id === rev2.json.id);
  assert.equal(superseded.proposal_status, "superseded");

  // the superseded revision remains adoptable through the API —
  // no 4xx contract forbids it today
  const adopt = await api("POST", `/api/documents/${docId}/adopt`, {
    revision_id: rev2.json.id,
    expected_version: view.state_version,
  });
  assert.equal(adopt.status, 200);
  assert.equal(adopt.json.adopted_revision_id, rev2.json.id);
});

// ── Document amendment via chat directive ──────────────────────────

/** project → adopt intent+output_policy → blueprint v → script doc.
 *  The doc's initial revision is PENDING (not auto-adopted). */
async function setupDocProject(name: string) {
  const proj = await api("POST", "/api/projects", { name });
  const pid = proj.json.id;
  const st0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = st0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content: `${kind}: frozen intent`,
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  }
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  return {
    pid,
    bvId: bv.json.id,
    doc: doc.json.document,
    rev0: doc.json.revision,
  };
}

test("chat directive: pending LLM amendment with provenance; adoption untouched", async () => {
  const { pid, bvId, doc, rev0 } = await setupDocProject("amend-ok");
  llm.reset();

  const res = await api("POST", `/api/projects/${pid}/messages`, {
    content: "結末を別のものに変えて",
    document_revision_id: rev0.id,
  });
  assert.equal(res.status, 200);
  const saved = res.json.document_revision;
  assert.ok(saved, "amendment revision should be saved");
  assert.equal(saved.proposal_status, "pending");
  assert.equal(saved.source, "llm");
  assert.equal(saved.base_revision_id, rev0.id);
  assert.equal(saved.blueprint_version_id, bvId);
  assert.ok(saved.instruction_message_id);
  assert.ok(saved.content.includes("結末を別のものに変えて"));

  // the instruction itself is the recorded provenance, and survives a
  // fresh state read (server-side persistence, not a UI note)
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  const view = st.documents.find((d: any) => d.id === doc.id);
  assert.equal(view.adopted_revision_id, null); // adoption untouched
  const fresh = view.revisions.find((r: any) => r.id === saved.id);
  assert.equal(fresh.instruction_message_id, saved.instruction_message_id);
  const instr = st.messages.find(
    (m: any) => m.id === saved.instruction_message_id,
  );
  assert.equal(instr.content, "結末を別のものに変えて");
  assert.equal(instr.role, "user");

  // the recorded outcome links instruction → reply → saved revision
  const outcome = st.amendment_outcomes.find(
    (o: any) => o.instruction_message_id === saved.instruction_message_id,
  );
  assert.ok(outcome, "a saved outcome row must exist");
  assert.equal(outcome.outcome, "saved");
  assert.equal(outcome.result_revision_id, saved.id);
  assert.equal(outcome.reject_reason, null);
  assert.equal(outcome.document_id, doc.id);
  assert.equal(outcome.base_revision_id, rev0.id);
  assert.equal(outcome.blueprint_version_id, bvId);
  const replyMsg = st.messages.find(
    (m: any) => m.id === outcome.assistant_message_id,
  );
  assert.equal(replyMsg.role, "assistant");

  // the provider saw the base body, the frozen context, and the
  // directive — resolved server-side, no model-chosen ids
  const input = llm.lastAmendInput!;
  assert.equal(input.document.base_content, rev0.content);
  assert.equal(input.document.base_rev_no, rev0.rev_no);
  assert.equal(input.instruction, "結末を別のものに変えて");
  assert.equal(input.frozen_context?.version_no, 1);
  assert.ok(
    input.frozen_context!.items.some((i) =>
      i.content.includes("frozen intent"),
    ),
  );
});

test("directive resolves document from revision — same-project other doc valid, foreign/unknown rejected", async () => {
  const a = await setupDocProject("amend-a");
  const b = await setupDocProject("amend-b");

  // The API resolves the document from the revision id — a revision of
  // ANOTHER document in the same project is a valid directive target
  // (this is the current contract, not an error).
  const doc2 = await api("POST", `/api/projects/${a.pid}/documents`, {
    kind: "storyboard",
    blueprint_version_id: a.bvId,
  });
  const bad1 = await api("POST", `/api/projects/${a.pid}/messages`, {
    content: "x",
    document_revision_id: doc2.json.revision.id,
  });
  assert.equal(bad1.status, 200);
  assert.ok(bad1.json.document_revision); // amendment lands on doc2

  // a revision belonging to a DIFFERENT project
  const bad2 = await api("POST", `/api/projects/${a.pid}/messages`, {
    content: "x",
    document_revision_id: b.rev0.id,
  });
  assert.equal(bad2.status, 400);

  // a nonexistent revision id
  const bad3 = await api("POST", `/api/projects/${a.pid}/messages`, {
    content: "x",
    document_revision_id: "no-such-rev",
  });
  assert.equal(bad3.status, 400);
});

test("directive: reply with no amendment saves nothing and flags nothing", async () => {
  const { pid, doc, rev0 } = await setupDocProject("amend-reply");
  llm.reset();
  llm.amendOutput = { reply: "確認だけです", amendment: undefined };
  try {
    const res = await api("POST", `/api/projects/${pid}/messages`, {
      content: "look at this",
      document_revision_id: rev0.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.document_revision, null);
    assert.equal(res.json.rejected_amendment, undefined);
  } finally {
    llm.reset();
  }
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  assert.equal(
    st.documents.find((d: any) => d.id === doc.id).revisions.length,
    1,
  );
  // the reply-only outcome is recorded against the instruction — not
  // inferred from there being no new revision
  const outcome = st.amendment_outcomes.find(
    (o: any) => o.document_id === doc.id,
  );
  assert.equal(outcome?.outcome, "reply_only");
  assert.equal(outcome.result_revision_id, null);
  assert.equal(outcome.base_revision_id, rev0.id);
});

test("directive: unparseable amendment block is rejected distinctly, not saved", async () => {
  const { pid, doc, rev0 } = await setupDocProject("amend-broken");
  llm.reset();
  // the model claims it saved AND emits a block that cannot be read —
  // the claim is prose; only a valid amendment may be stored
  llm.amendOutput = {
    reply: "修正案を保存しました",
    amendment_error: "amendment block is not valid JSON",
  };
  try {
    const res = await api("POST", `/api/projects/${pid}/messages`, {
      content: "rewrite",
      document_revision_id: rev0.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.document_revision, null);
    assert.ok(res.json.rejected_amendment?.includes("JSON"));
  } finally {
    llm.reset();
  }
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  assert.equal(
    st.documents.find((d: any) => d.id === doc.id).revisions.length,
    1,
  );
  // rejected is persisted with its reason — the prose claim of a save
  // left no revision, and the refusal itself is on the record
  const outcome = st.amendment_outcomes.find(
    (o: any) => o.document_id === doc.id,
  );
  assert.equal(outcome?.outcome, "rejected");
  assert.ok(outcome.reject_reason?.includes("JSON"));
  assert.equal(outcome.result_revision_id, null);
});

test("directive: oversized amendment body is rejected, never truncated", async () => {
  const { pid, doc, rev0 } = await setupDocProject("amend-huge");
  llm.reset();
  llm.amendOverride = { content: "x".repeat(200_000) };
  try {
    const res = await api("POST", `/api/projects/${pid}/messages`, {
      content: "expand",
      document_revision_id: rev0.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.document_revision, null);
    assert.ok(res.json.rejected_amendment?.includes("limit"));
  } finally {
    llm.reset();
  }
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  assert.equal(
    st.documents.find((d: any) => d.id === doc.id).revisions.length,
    1,
  );
  const outcome = st.amendment_outcomes.find(
    (o: any) => o.document_id === doc.id,
  );
  assert.equal(outcome?.outcome, "rejected");
  assert.ok(outcome.reject_reason?.includes("limit"));
});

test("directive: LLM failure saves no amendment and no fake reply", async () => {
  const { pid, doc, rev0 } = await setupDocProject("amend-fail");
  llm.reset();
  llm.amendError = new Error("provider down");
  try {
    const res = await api("POST", `/api/projects/${pid}/messages`, {
      content: "fail me",
      document_revision_id: rev0.id,
    });
    assert.equal(res.status, 500);
  } finally {
    llm.amendError = null;
  }
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  const view = st.documents.find((d: any) => d.id === doc.id);
  assert.equal(view.revisions.length, 1); // only the initial revision
  // no assistant message pretending an amendment happened
  assert.ok(
    !st.messages.some(
      (m: any) => m.role === "assistant" && m.content.includes("修正案"),
    ),
  );
  // a failed call records NO outcome — the directive stays "unknown",
  // it is never guess-converted into reply_only or rejected
  assert.equal(
    st.amendment_outcomes.filter((o: any) => o.document_id === doc.id).length,
    0,
  );
});

test("directive: malformed amendment body is rejected — reply kept, no draft", async () => {
  const { pid, doc, rev0 } = await setupDocProject("amend-bad");
  llm.reset();
  llm.amendOverride = { no_content: true };
  try {
    const res = await api("POST", `/api/projects/${pid}/messages`, {
      content: "bad shape",
      document_revision_id: rev0.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.document_revision, null);
    assert.ok(res.json.rejected_amendment);
  } finally {
    llm.amendOverride = undefined;
  }
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  const view = st.documents.find((d: any) => d.id === doc.id);
  assert.equal(view.revisions.length, 1);
  const outcome = st.amendment_outcomes.find(
    (o: any) => o.document_id === doc.id,
  );
  assert.equal(outcome?.outcome, "rejected");
  assert.ok(outcome.reject_reason);
  assert.equal(outcome.result_revision_id, null);
});

test("directive: adoption landing mid-call aborts the save with 409", async () => {
  const { pid, doc, rev0 } = await setupDocProject("amend-race");
  // a second pending revision that gets adopted mid-call
  const rev1 = await api("POST", `/api/documents/${doc.id}/revisions`, {
    content: "competing draft",
    base_revision_id: rev0.id,
  });
  const freshView = (
    await api("GET", `/api/projects/${pid}/state`)
  ).json.documents.find((d: any) => d.id === doc.id);
  llm.reset();
  llm.onAmend = () =>
    adoptDocumentRevision(db, {
      document_id: doc.id,
      revision_id: rev1.json.id,
      expected_version: freshView.state_version,
    });
  try {
    const res = await api("POST", `/api/projects/${pid}/messages`, {
      content: "meanwhile",
      document_revision_id: rev0.id,
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "conflict");
  } finally {
    llm.onAmend = null;
  }
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  const view = st.documents.find((d: any) => d.id === doc.id);
  assert.equal(view.adopted_revision_id, rev1.json.id); // adoption stands
  assert.equal(view.revisions.length, 2); // no stale-premise draft saved
  // the rolled-back assistant reply was not persisted
  assert.ok(
    !st.messages.some(
      (m: any) => m.role === "assistant" && m.content.includes("修正案"),
    ),
  );
  // a 409 records NO outcome — not reply_only, not rejected: unknown
  assert.equal(
    st.amendment_outcomes.filter((o: any) => o.document_id === doc.id).length,
    0,
  );
});

test("directive: frozen context is the base's blueprint, live drift stays separate", async () => {
  const { pid, rev0 } = await setupDocProject("amend-drift");
  llm.reset();

  // move the intent item past the frozen snapshot after the doc exists
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  const intent = st.items.find((i: any) => i.kind === "intent");
  const rev = await api("POST", `/api/items/${intent.id}/revisions`, {
    content: "intent: live update",
  });
  await api("POST", `/api/items/${intent.id}/adopt`, {
    revision_id: rev.json.id,
    expected_version: intent.state_version,
  });

  const res = await api("POST", `/api/projects/${pid}/messages`, {
    content: "長さを半分に",
    document_revision_id: rev0.id,
  });
  assert.equal(res.status, 200);
  const input = llm.lastAmendInput!;
  // frozen context still describes the snapshot the base came from
  const intentItem = input.frozen_context!.items.find(
    (i) => i.kind === "intent",
  );
  assert.ok(intentItem, "frozen context must carry the intent item");
  assert.ok(intentItem.content.includes("frozen intent"));
  assert.ok(!intentItem.content.includes("live update"));
  // the live divergence is reported separately, not mixed into the basis
  assert.ok(input.drift_notes.length > 0);
  assert.ok(
    !input.frozen_context!.items.some((i) => i.content.includes("live update")),
  );
});

// ---- scene input draft (read-only preview) ----

async function setupSceneProject(name: string) {
  const proj = await api("POST", "/api/projects", { name });
  const pid = proj.json.id;
  const st0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  const adoptItem = async (kind: string, content: string) => {
    const item = st0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content,
    });
    const adopt = await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
    assert.equal(adopt.status, 200);
    return rev.json.id;
  };
  const intentRevId = await adoptItem(
    "intent",
    "雨上がりの街を歩く少女の、静かな一場面を描く短い映像",
  );
  const constraintRevId = await adoptItem(
    "fixed_constraint",
    "髪型: 黒のロングヘア / 服装: 紺の制服ブレザー",
  );
  await adoptItem("output_policy", "静止画1枚・横長");

  // a pinned character whose locked trait normalizes to the SAME
  // constraint text — exercises dedup-by-merge with both provenances
  const chr = await api("POST", "/api/characters", { name: "少女" });
  const chrRev = await api("POST", `/api/characters/${chr.json.id}/revisions`, {
    profile: {
      appearance: "黒髪の少女",
      traits: {
        locked: { 髪型: "黒のロングヘア / 服装: 紺の制服ブレザー" },
      },
    },
  });
  const pin = await api("PUT", `/api/projects/${pid}/characters`, {
    character_id: chr.json.id,
    character_revision_id: chrRev.json.id,
    expected_version: null,
  });
  assert.equal(pin.status, 200);

  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  const rev0 = doc.json.revision;
  const rev1 = await api(
    "POST",
    `/api/documents/${doc.json.document.id}/revisions`,
    {
      content:
        "場面: 夕方の雨上がりの駅前。少女がベンチに座り、空を見上げている。" +
        "黒のロングヘア、紺の制服ブレザー。穏やかな光。",
      base_revision_id: rev0.id,
    },
  );
  const docState = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script = docState.documents.find(
    (d: any) => d.id === doc.json.document.id,
  );
  const adopt = await api(
    "POST",
    `/api/documents/${doc.json.document.id}/adopt`,
    {
      revision_id: rev1.json.id,
      expected_version: script.state_version,
    },
  );
  assert.equal(adopt.status, 200);
  return {
    pid,
    bvId: bv.json.id,
    docId: doc.json.document.id,
    rev0,
    rev1: rev1.json,
    intentRevId,
    constraintRevId,
  };
}

test("scene draft: reorders approved content; never auto-resolves", async () => {
  const f = await setupSceneProject("scene-draft-ok");
  const eventsBefore = db
    .prepare("SELECT COUNT(*) AS n FROM approval_events")
    .get() as { n: number };
  const submitsBefore = genSubmits;
  const llmBefore = llm.llmCalls;

  const res = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft` +
      `?blueprint_version_id=${f.bvId}` +
      `&document_revision_id=${f.rev1.id}`,
  );
  assert.equal(res.status, 200);
  const d = res.json;
  assert.equal(d.status, "preview");
  assert.equal(d.blueprint_version_id, f.bvId);
  assert.equal(d.document_revision_id, f.rev1.id);
  assert.equal(d.document_rev_no, f.rev1.rev_no);
  assert.equal(d.payload_version, 1);
  assert.equal(d.builder_version, 1);
  assert.match(d.digest, /^[a-f0-9]{64}$/);

  // A — posture split by scope, never merged or resolved; BOTH
  // scopes are cited on the question
  assert.match(d.scene.content, /ベンチに座り/);
  const intentCtx = d.context.find((s: any) => s.content.includes("歩く"));
  assert.ok(intentCtx, "piece-level 歩く stays in piece context");
  assert.ok(!d.scene.content.includes("歩く"));
  const postureQ = d.open_questions.find(
    (q: any) => q.kind === "posture_scope",
  );
  assert.ok(postureQ, "posture scope tension is a question, not a fix");
  const postureSrcKinds = postureQ.sources.map((s: any) => s.kind).sort();
  assert.deepEqual(
    postureSrcKinds,
    ["document_revision", "item_revision"],
    "posture question cites BOTH the scene and the piece side",
  );
  assert.ok(
    postureQ.related.some((r: any) => r.content.includes("座り")) &&
      postureQ.related.some((r: any) => r.content.includes("歩く")),
    "both posture descriptions stay visible as related text",
  );

  // B — fixed condition kept verbatim, never weakened
  const cond = "髪型: 黒のロングヘア / 服装: 紺の制服ブレザー";
  const entries = d.constraints.filter((s: any) => s.content === cond);
  assert.equal(entries.length, 1, "one entry for the identical condition");
  assert.ok(
    !d.constraints.some((s: any) => s.content.includes("暗い服")),
    "condition must not be paraphrased away",
  );

  // C — dedup keeps BOTH provenances on the merged entry
  const srcKinds = entries[0].sources.map((s: any) => s.kind).sort();
  assert.deepEqual(srcKinds, ["character_revision", "item_revision"]);
  // and the scene text itself still carries the same phrases verbatim
  assert.match(d.scene.content, /黒のロングヘア、紺の制服ブレザー/);

  // D — checks report their coverage instead of silently vanishing
  const byKind = (k: string) => d.open_questions.find((q: any) => q.kind === k);
  for (const k of [
    "style",
    "color",
    "main_subject",
    "background_people",
    "composition",
    "negative_policy",
  ]) {
    assert.ok(byKind(k), `missing check ${k}`);
    // no uninspected sources in this fixture → verdict is over the
    // inspected range
    assert.equal(
      byKind(k).status,
      "none_found",
      `${k} should report none_found over the inspected range`,
    );
  }
  assert.equal(postureQ.status, "related_text_found");
  assert.ok(
    !d.constraints.some((s: any) => /anime|モノクロ|photo/i.test(s.content)),
    "no style/colour value may be invented as a condition",
  );

  // adopted items with no scene meaning are kept, not dropped
  assert.ok(
    d.unclassified.some((s: any) => s.content.includes("静止画1枚・横長")),
    "output_policy stays as an unclassified adopted note",
  );
  assert.deepEqual(d.unresolved_sources, []);
  assert.deepEqual(d.uninspected_sources, []);

  // provenance — every section entry names its sources
  assert.equal(d.scene.sources[0].kind, "document_revision");
  assert.ok(
    d.constraints.every((s: any) => s.sources.length >= 1),
    "every constraint keeps a source",
  );

  // F — the preview is a pure read: nothing was written or generated
  const eventsAfter = db
    .prepare("SELECT COUNT(*) AS n FROM approval_events")
    .get() as { n: number };
  assert.equal(eventsAfter.n, eventsBefore.n);
  assert.equal(genSubmits, submitsBefore, "backend never called");
  assert.equal(llm.llmCalls, llmBefore, "LLM never called");
  const st = (await api("GET", `/api/projects/${f.pid}/state`)).json;
  const script = st.documents.find((x: any) => x.id === f.docId);
  assert.equal(script.adopted_revision_id, f.rev1.id);
  assert.equal(st.generations.length, 0);
  assert.equal(st.amendment_outcomes.length, 0);
});

test("scene draft: saves only the confirmed immutable preview snapshot", async () => {
  const f = await setupSceneProject("scene-draft-save");
  const other = await setupSceneProject("scene-draft-save-other");
  const preview = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft?blueprint_version_id=${f.bvId}` +
      `&document_revision_id=${f.rev1.id}`,
  );
  assert.equal(preview.status, 200);
  const draft = preview.json;
  const eventsBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM approval_events").get() as {
      n: number;
    }
  ).n;
  const callsBefore = llm.llmCalls;
  const submitsBefore = genSubmits;
  const request = {
    blueprint_version_id: f.bvId,
    document_id: f.docId,
    document_revision_id: f.rev1.id,
    digest: draft.digest,
  };
  const save = await api(
    "POST",
    `/api/projects/${f.pid}/scene-input-drafts`,
    request,
  );
  assert.equal(save.status, 201, JSON.stringify(save.json));
  assert.equal(save.json.project_id, f.pid);
  assert.equal(save.json.blueprint_version_id, f.bvId);
  assert.equal(save.json.document_id, f.docId);
  assert.equal(save.json.document_revision_id, f.rev1.id);
  assert.equal(save.json.digest, draft.digest);
  assert.deepEqual(
    save.json.snapshot,
    draft,
    "stored payload exactly matches the displayed preview",
  );
  assert.equal(save.json.snapshot.status, "preview");
  assert.ok(save.json.saved_at);

  // Duplicate delivery is idempotent server-side.
  const duplicate = await api(
    "POST",
    `/api/projects/${f.pid}/scene-input-drafts`,
    request,
  );
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.json.id, save.json.id);
  const list = await api("GET", `/api/projects/${f.pid}/scene-input-drafts`);
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].id, save.json.id);
  const detail = await api(
    "GET",
    `/api/projects/${f.pid}/scene-input-drafts/${save.json.id}`,
  );
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.snapshot, draft);
  const state = await api("GET", `/api/projects/${f.pid}/state`);
  assert.equal(state.json.scene_input_drafts[0].id, save.json.id);
  const eventsAfterSave = (
    db.prepare("SELECT COUNT(*) AS n FROM approval_events").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    eventsAfterSave,
    eventsBefore,
    "save does not approve or change an adopted pointer",
  );

  // The database itself refuses mutation, independently of the API.
  assert.throws(
    () =>
      db
        .prepare("UPDATE scene_input_drafts SET digest = ? WHERE id = ?")
        .run("0".repeat(64), save.json.id),
    /immutable/,
  );
  assert.throws(
    () =>
      db
        .prepare("DELETE FROM scene_input_drafts WHERE id = ?")
        .run(save.json.id),
    /immutable/,
  );

  // The saved snapshot survives a later document adoption unchanged.
  const next = await api("POST", `/api/documents/${f.docId}/revisions`, {
    content: "場面: 新しい採用版。少女が歩く。",
    base_revision_id: f.rev1.id,
  });
  const now = (await api("GET", `/api/projects/${f.pid}/state`)).json;
  const doc = now.documents.find((d: any) => d.id === f.docId);
  const adopted = await api("POST", `/api/documents/${f.docId}/adopt`, {
    revision_id: next.json.id,
    expected_version: doc.state_version,
  });
  assert.equal(adopted.status, 200);
  const staleSave = await api(
    "POST",
    `/api/projects/${f.pid}/scene-input-drafts`,
    request,
  );
  assert.equal(staleSave.status, 409);
  const reopenedDetail = await api(
    "GET",
    `/api/projects/${f.pid}/scene-input-drafts/${save.json.id}`,
  );
  assert.equal(reopenedDetail.status, 200);
  assert.deepEqual(reopenedDetail.json.snapshot, draft);
  assert.match(reopenedDetail.json.snapshot.scene.content, /ベンチに座り/);

  const tampered = await api(
    "POST",
    `/api/projects/${f.pid}/scene-input-drafts`,
    {
      ...request,
      digest: `${draft.digest[0] === "0" ? "1" : "0"}${draft.digest.slice(1)}`,
    },
  );
  assert.equal(tampered.status, 409);
  const forged = await api(
    "POST",
    `/api/projects/${f.pid}/scene-input-drafts`,
    {
      ...request,
      scene: { content: "client-authored" },
    },
  );
  assert.equal(forged.status, 400);

  const foreignTarget = await api(
    "POST",
    `/api/projects/${f.pid}/scene-input-drafts`,
    {
      ...request,
      blueprint_version_id: other.bvId,
      document_id: other.docId,
      document_revision_id: other.rev1.id,
    },
  );
  assert.equal(foreignTarget.status, 400);
  const otherPreview = await api(
    "GET",
    `/api/projects/${other.pid}/scene-draft?blueprint_version_id=${other.bvId}` +
      `&document_revision_id=${other.rev1.id}`,
  );
  const otherSaved = await api(
    "POST",
    `/api/projects/${other.pid}/scene-input-drafts`,
    {
      blueprint_version_id: other.bvId,
      document_id: other.docId,
      document_revision_id: other.rev1.id,
      digest: otherPreview.json.digest,
    },
  );
  assert.equal(otherSaved.status, 201);
  const foreignDetail = await api(
    "GET",
    `/api/projects/${f.pid}/scene-input-drafts/${otherSaved.json.id}`,
  );
  assert.equal(foreignDetail.status, 404);
  assert.equal(
    genSubmits,
    submitsBefore,
    "save/detail never calls generation backend",
  );
  assert.equal(llm.llmCalls, callsBefore, "save/detail never calls LLM");
  const eventsAfter = (
    db.prepare("SELECT COUNT(*) AS n FROM approval_events").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    eventsAfter,
    eventsBefore + 1,
    "only the explicit adoption changed approvals",
  );
});

test("scene draft review: explicit versioned progress persists without changing the snapshot", async () => {
  const f = await setupSceneProject("scene-review-progress");
  const other = await setupSceneProject("scene-review-progress-other");
  const submitsBefore = genSubmits;
  const callsBefore = llm.llmCalls;
  const preview = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft?blueprint_version_id=${f.bvId}` +
      `&document_revision_id=${f.rev1.id}`,
  );
  const saved = await api("POST", `/api/projects/${f.pid}/scene-input-drafts`, {
    blueprint_version_id: f.bvId,
    document_id: f.docId,
    document_revision_id: f.rev1.id,
    digest: preview.json.digest,
  });
  assert.equal(saved.status, 201);
  const draftId = saved.json.id;
  const stateBefore = (await api("GET", `/api/projects/${f.pid}/state`)).json;
  const approvalCountBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM approval_events").get() as {
      n: number;
    }
  ).n;
  const generationCountBefore = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM generation_records WHERE project_id = ?",
      )
      .get(f.pid) as { n: number }
  ).n;
  const outcomeCountBefore = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM amendment_outcomes WHERE project_id = ?",
      )
      .get(f.pid) as { n: number }
  ).n;
  const reviewUrl = `/api/projects/${f.pid}/scene-input-drafts/${draftId}/review`;
  const initial = await api("GET", reviewUrl);
  assert.equal(initial.status, 200);
  assert.equal(initial.json.persisted, false);
  assert.equal(initial.json.version, 0);
  const dbRowsBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM scene_input_draft_reviews").get() as {
      n: number;
    }
  ).n;
  const repeated = await api("GET", reviewUrl);
  assert.deepEqual(
    repeated.json,
    initial.json,
    "read-only defaults are stable",
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM scene_input_draft_reviews")
        .get() as { n: number }
    ).n,
    dbRowsBefore,
    "GET does not create a progress row",
  );

  const first =
    initial.json.items.find((item: any) => item.kind === "constraint") ??
    initial.json.items[0];
  assert.ok(first);
  const request = {
    expected_version: 0,
    items: initial.json.items.map((item: any) => ({
      id: item.id,
      status: item.id === first.id ? "in_progress" : item.status,
      answer: item.id === first.id ? "途中回答" : item.answer,
      memo: item.id === first.id ? "手元メモ" : item.memo,
    })),
    unresolved_issues: [
      {
        id: "issue_abcdefgh",
        text: "未確認の論点を残す",
        status: "unconfirmed",
        answer: "",
        memo: "",
      },
    ],
    resume_target: { draft_id: draftId, issue_id: "issue_abcdefgh" },
  };
  const savedReview = await api("PUT", reviewUrl, request);
  assert.equal(savedReview.status, 200, JSON.stringify(savedReview.json));
  assert.equal(savedReview.json.persisted, true);
  assert.equal(savedReview.json.version, 1);
  assert.equal(
    savedReview.json.items.find((item: any) => item.id === first.id).answer,
    "途中回答",
  );
  assert.deepEqual(savedReview.json.resume_target, {
    draft_id: draftId,
    issue_id: "issue_abcdefgh",
  });
  assert.deepEqual(
    (await api("GET", `/api/projects/${f.pid}/state`)).json.documents.map(
      (doc: any) => [doc.id, doc.adopted_revision_id],
    ),
    stateBefore.documents.map((doc: any) => [doc.id, doc.adopted_revision_id]),
    "review progress does not change adopted pointers",
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM approval_events").get() as {
        n: number;
      }
    ).n,
    approvalCountBefore,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM generation_records WHERE project_id = ?",
        )
        .get(f.pid) as { n: number }
    ).n,
    generationCountBefore,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM amendment_outcomes WHERE project_id = ?",
        )
        .get(f.pid) as { n: number }
    ).n,
    outcomeCountBefore,
  );
  assert.equal(
    genSubmits,
    submitsBefore,
    "review read/save does not call generation backend",
  );
  assert.equal(llm.llmCalls, callsBefore, "review read/save does not call LLM");

  const stale = await api("PUT", reviewUrl, {
    ...request,
    expected_version: 0,
  });
  assert.equal(
    stale.status,
    409,
    "stale writers cannot overwrite newer progress",
  );
  const afterStale = await api("GET", reviewUrl);
  assert.equal(
    afterStale.json.items.find((item: any) => item.id === first.id).answer,
    "途中回答",
  );
  const badItem = await api("PUT", reviewUrl, {
    ...request,
    expected_version: 1,
    items: [{ id: "forged-item", status: "confirmed", answer: "", memo: "" }],
  });
  assert.equal(badItem.status, 400);
  const badIssueId = await api("PUT", reviewUrl, {
    ...request,
    expected_version: 1,
    unresolved_issues: [
      {
        id: "issue_short",
        text: "無効ID",
        status: "unconfirmed",
        answer: "",
        memo: "",
      },
    ],
  });
  assert.equal(
    badIssueId.status,
    400,
    "malformed custom issue ids are refused",
  );
  const unknownResumeIssue = await api("PUT", reviewUrl, {
    ...request,
    expected_version: 1,
    resume_target: { draft_id: draftId, issue_id: "issue_missing123" },
  });
  assert.equal(
    unknownResumeIssue.status,
    400,
    "resume issue ids must belong to the referenced draft",
  );
  const foreignRead = await api(
    "GET",
    `/api/projects/${other.pid}/scene-input-drafts/${draftId}/review`,
  );
  assert.equal(foreignRead.status, 404);
  const foreignPreview = await api(
    "GET",
    `/api/projects/${other.pid}/scene-draft?blueprint_version_id=${other.bvId}` +
      `&document_revision_id=${other.rev1.id}`,
  );
  const foreignSaved = await api(
    "POST",
    `/api/projects/${other.pid}/scene-input-drafts`,
    {
      blueprint_version_id: other.bvId,
      document_id: other.docId,
      document_revision_id: other.rev1.id,
      digest: foreignPreview.json.digest,
    },
  );
  assert.equal(foreignSaved.status, 201);
  const foreignReadByOwner = await api(
    "GET",
    `/api/projects/${f.pid}/scene-input-drafts/${foreignSaved.json.id}/review`,
  );
  assert.equal(
    foreignReadByOwner.status,
    404,
    "another project's draft is inaccessible from this project",
  );
  const foreignResume = await api("PUT", reviewUrl, {
    ...request,
    expected_version: 1,
    resume_target: { draft_id: foreignSaved.json.id, issue_id: first.id },
  });
  assert.equal(
    foreignResume.status,
    404,
    "resume targets must belong to this project",
  );

  const competingBody = (answer: string) => ({
    ...request,
    expected_version: 1,
    items: request.items.map((item: any) => ({
      ...item,
      answer: item.id === first.id ? answer : item.answer,
    })),
  });
  const concurrentResults = await Promise.all([
    api("PUT", reviewUrl, competingBody("並行更新A")),
    api("PUT", reviewUrl, competingBody("並行更新B")),
  ]);
  assert.deepEqual(
    concurrentResults.map((result) => result.status).sort(),
    [200, 409],
    "only one writer with the same expected_version commits",
  );
  const concurrentWinner = await api("GET", reviewUrl);
  assert.equal(concurrentWinner.json.version, 2);
  assert.ok(
    ["並行更新A", "並行更新B"].includes(
      concurrentWinner.json.items.find((item: any) => item.id === first.id)
        .answer,
    ),
  );

  // Two clients load the same real handler/DB version. The second retains
  // its local body after a real 409, reads latest, and explicitly retries
  // with that version. No mock route is involved in this recovery path.
  const clientARead = await api("GET", reviewUrl);
  const clientBRead = await api("GET", reviewUrl);
  assert.equal(clientARead.json.version, clientBRead.json.version);
  const recoveryBody = (base: any, answer: string) => ({
    expected_version: base.version,
    items: base.items.map((item: any) => ({
      id: item.id,
      status: item.id === first.id ? "in_progress" : item.status,
      answer: item.id === first.id ? answer : item.answer,
      memo: item.memo,
    })),
    unresolved_issues: base.unresolved_issues,
    resume_target: base.resume_target,
  });
  const clientAWrite = await api(
    "PUT",
    reviewUrl,
    recoveryBody(clientARead.json, "client A wins first"),
  );
  assert.equal(clientAWrite.status, 200);
  const handEdit = recoveryBody(
    clientBRead.json,
    "client B retained local input",
  );
  const clientBConflict = await api("PUT", reviewUrl, handEdit);
  assert.equal(clientBConflict.status, 409);
  const latestForCompare = await api("GET", reviewUrl);
  assert.equal(latestForCompare.status, 200);
  assert.equal(latestForCompare.json.version, clientAWrite.json.version);
  assert.equal(
    handEdit.items.find((item: any) => item.id === first.id).answer,
    "client B retained local input",
  );
  const recovered = await api("PUT", reviewUrl, {
    ...handEdit,
    expected_version: latestForCompare.json.version,
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.version, latestForCompare.json.version + 1);
  assert.equal(
    recovered.json.items.find((item: any) => item.id === first.id).answer,
    "client B retained local input",
  );

  const secondDoc = await api("POST", `/api/projects/${f.pid}/documents`, {
    kind: "script",
    blueprint_version_id: f.bvId,
  });
  const secondRevision = await api(
    "POST",
    `/api/documents/${secondDoc.json.document.id}/revisions`,
    {
      content: "場面: 同じ作品の別資料。別の構図を検討する。",
      base_revision_id: secondDoc.json.revision.id,
    },
  );
  const stateBeforeSecondAdopt = (
    await api("GET", `/api/projects/${f.pid}/state`)
  ).json;
  const secondDocumentView = stateBeforeSecondAdopt.documents.find(
    (doc: any) => doc.id === secondDoc.json.document.id,
  );
  const secondAdopt = await api(
    "POST",
    `/api/documents/${secondDoc.json.document.id}/adopt`,
    {
      revision_id: secondRevision.json.id,
      expected_version: secondDocumentView.state_version,
    },
  );
  assert.equal(secondAdopt.status, 200);
  const secondPreview = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft?blueprint_version_id=${f.bvId}` +
      `&document_revision_id=${secondRevision.json.id}`,
  );
  const secondSaved = await api(
    "POST",
    `/api/projects/${f.pid}/scene-input-drafts`,
    {
      blueprint_version_id: f.bvId,
      document_id: secondDoc.json.document.id,
      document_revision_id: secondRevision.json.id,
      digest: secondPreview.json.digest,
    },
  );
  assert.equal(secondSaved.status, 201);
  const secondReviewUrl = `/api/projects/${f.pid}/scene-input-drafts/${secondSaved.json.id}/review`;
  const secondReview = await api("GET", secondReviewUrl);
  assert.equal(secondReview.json.persisted, false);
  assert.equal(secondReview.json.version, 0);
  assert.ok(
    secondReview.json.items.length > 0 &&
      secondReview.json.items.every(
        (item: any) =>
          item.status === "unconfirmed" &&
          item.answer === "" &&
          item.memo === "",
      ),
  );
  assert.deepEqual(secondReview.json.unresolved_issues, []);
  assert.equal(secondReview.json.resume_target, null);
  const foreignDraftIssue = await api("PUT", secondReviewUrl, {
    expected_version: 0,
    items: secondReview.json.items.map((item: any) => ({
      id: item.id,
      status: item.status,
      answer: item.answer,
      memo: item.memo,
    })),
    unresolved_issues: [],
    resume_target: { draft_id: secondSaved.json.id, issue_id: first.id },
  });
  assert.equal(
    foreignDraftIssue.status,
    400,
    "a system issue id cannot be reused across drafts",
  );

  const snapshotAfter = await api(
    "GET",
    `/api/projects/${f.pid}/scene-input-drafts/${draftId}`,
  );
  assert.deepEqual(snapshotAfter.json.snapshot, preview.json);
  assert.equal(snapshotAfter.json.digest, saved.json.digest);
  const stateAfter = (await api("GET", `/api/projects/${f.pid}/state`)).json;
  assert.deepEqual(
    stateAfter.documents
      .filter((doc: any) =>
        stateBefore.documents.some((before: any) => before.id === doc.id),
      )
      .map((doc: any) => [doc.id, doc.adopted_revision_id]),
    stateBefore.documents.map((doc: any) => [doc.id, doc.adopted_revision_id]),
    "the later explicit adoption leaves the original document pointer intact",
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM approval_events").get() as {
        n: number;
      }
    ).n,
    approvalCountBefore + 1,
    "only the explicit second-document adoption wrote its audit event",
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM generation_records WHERE project_id = ?",
        )
        .get(f.pid) as { n: number }
    ).n,
    generationCountBefore,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM amendment_outcomes WHERE project_id = ?",
        )
        .get(f.pid) as { n: number }
    ).n,
    outcomeCountBefore,
  );
});

test("scene draft: rejects invalid targets without pretending", async () => {
  const f = await setupSceneProject("scene-draft-e");

  // missing params → 400
  const noParams = await api("GET", `/api/projects/${f.pid}/scene-draft`);
  assert.equal(noParams.status, 400);

  // pending (un-adopted) revision is not a valid target
  const pending = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft` +
      `?blueprint_version_id=${f.bvId}&document_revision_id=${f.rev0.id}`,
  );
  assert.equal(pending.status, 422);

  // revision from another project → 422 (not 404, not success)
  const other = await setupSceneProject("scene-draft-other");
  const foreign = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft` +
      `?blueprint_version_id=${f.bvId}` +
      `&document_revision_id=${other.rev1.id}`,
  );
  assert.equal(foreign.status, 422);

  // adopted revision but wrong blueprint version → 422
  const wrongBv = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft` +
      `?blueprint_version_id=${other.bvId}` +
      `&document_revision_id=${f.rev1.id}`,
  );
  assert.equal(wrongBv.status, 422);

  // multi-scene document → 422, never silently picks the first scene
  const multi = await api("POST", `/api/documents/${f.docId}/revisions`, {
    content: "場面: 朝の駅。少女が立つ。\n場面: 夜の家。少女が寝る。",
    base_revision_id: f.rev1.id,
  });
  const st = (await api("GET", `/api/projects/${f.pid}/state`)).json;
  const script = st.documents.find((d: any) => d.id === f.docId);
  await api("POST", `/api/documents/${f.docId}/adopt`, {
    revision_id: multi.json.id,
    expected_version: script.state_version,
  });
  const multiRes = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft` +
      `?blueprint_version_id=${f.bvId}&document_revision_id=${multi.json.id}`,
  );
  assert.equal(multiRes.status, 422);
  assert.match(multiRes.json.error, /scene headings|target selection/i);

  // G — after adoption moved on, a draft for the OLD revision is a
  // 422 (the server never answers for a stale target)
  const stale = await api(
    "GET",
    `/api/projects/${f.pid}/scene-draft` +
      `?blueprint_version_id=${f.bvId}&document_revision_id=${f.rev1.id}`,
  );
  assert.equal(stale.status, 422);
});

// ---- scene draft: inspection honesty fixtures ----

async function setupFixtureProject(name: string) {
  const proj = await api("POST", "/api/projects", { name });
  const pid = proj.json.id;
  const st0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  const adoptItem = async (kind: string, content: string) => {
    const item = st0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content,
    });
    const adopt = await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
    assert.equal(adopt.status, 200);
    return rev.json.id;
  };
  // fixture A–D text: explicit "undecided" statements in the intent
  await adoptItem(
    "intent",
    "画風はアニメか実写か未定。カラーかモノクロか未定。" +
      "主役は一人、背景人物の人数は未定。カメラと構図は未定。" +
      "雨上がりの街を歩く少女。",
  );
  // fixture H: DIFFERING constraints coexisting with a duplicate
  await adoptItem("fixed_constraint", "髪型: 黒のロングヘア");
  // fixture F: colour note lives only in the output policy
  await adoptItem("output_policy", "静止画1枚・モノクロ");

  const chr = await api("POST", "/api/characters", { name: "ヒロイン" });
  const chrRev = await api("POST", `/api/characters/${chr.json.id}/revisions`, {
    profile: {
      appearance: "黒髪の少女",
      traits: {
        locked: { 髪型: "黒のロングヘア", 目の色: "琥珀色" },
      },
    },
  });
  await api("PUT", `/api/projects/${pid}/characters`, {
    character_id: chr.json.id,
    character_revision_id: chrRev.json.id,
    expected_version: null,
  });

  // fixture G: a text material whose FILENAME mentions monochrome —
  // the filename must never be treated as content evidence
  const asset = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "material",
    name: "monochrome-notes.txt",
    mime: "text/plain",
    content_base64: Buffer.from("（素材メモ）").toString("base64"),
  });
  assert.equal(asset.status, 201);
  await api("POST", `/api/assets/${asset.json.id}/select`, {
    selected: true, expected_version: 0,
  });

  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const mkDoc = async (content: string, title = "台本") => {
    const doc = await api("POST", `/api/projects/${pid}/documents`, {
      kind: "script",
      blueprint_version_id: bv.json.id,
      title,
    });
    const r = await api(
      "POST",
      `/api/documents/${doc.json.document.id}/revisions`,
      { content, base_revision_id: doc.json.revision.id },
    );
    const st = (await api("GET", `/api/projects/${pid}/state`)).json;
    const dv = st.documents.find((d: any) => d.id === doc.json.document.id);
    const adopt = await api(
      "POST",
      `/api/documents/${doc.json.document.id}/adopt`,
      { revision_id: r.json.id, expected_version: dv.state_version },
    );
    assert.equal(adopt.status, 200);
    return { docId: doc.json.document.id, rev: r.json };
  };
  return { pid, bvId: bv.json.id, assetId: asset.json.id, mkDoc };
}

const draftGet = (pid: string, bvId: string, revId: string) =>
  api(
    "GET",
    `/api/projects/${pid}/scene-draft` +
      `?blueprint_version_id=${bvId}&document_revision_id=${revId}`,
  );

test("scene draft: 'undecided' wording stays a question — never resolved by keywords", async () => {
  const f = await setupFixtureProject("scene-draft-abcd");
  const d1 = await f.mkDoc("場面: 夕方の雨上がりの駅前。少女が立つ。");
  const res = await draftGet(f.pid, f.bvId, d1.rev.id);
  assert.equal(res.status, 200);
  const d = res.json;
  const byKind = (k: string) => d.open_questions.find((q: any) => q.kind === k);

  // A–D: "未定" statements are LOCATED as related text and shown
  // verbatim — the question is NOT suppressed by a keyword hit
  const style = byKind("style");
  assert.ok(
    style.related.some((r: any) =>
      r.content.includes("画風はアニメか実写か未定"),
    ),
    "style: related text kept verbatim",
  );
  assert.notEqual(style.status, "none_found");

  const color = byKind("color");
  // fixture F: colour note comes from the output_policy item —
  // related text cites THAT source
  assert.ok(
    color.related.some(
      (r: any) =>
        r.content.includes("モノクロ") &&
        r.sources.some((s: any) => s.label?.includes("output_policy")),
    ),
    "color related cites the output_policy source",
  );
  assert.ok(
    d.unclassified.some((s: any) => s.content.includes("モノクロ")),
    "output_policy is kept as unclassified, not dropped",
  );

  // C: main subject vs background people are SEPARATE axes
  const main = byKind("main_subject");
  const bg = byKind("background_people");
  assert.ok(main.related.some((r: any) => r.content.includes("主役は一人")));
  assert.ok(
    bg.related.some((r: any) => r.content.includes("背景人物")),
    "background people get their own check — not resolved by 主役は一人",
  );

  // D: composition related text kept verbatim
  assert.ok(
    byKind("composition").related.some((r: any) =>
      r.content.includes("カメラと構図は未定"),
    ),
  );

  // G: the material asset is uninspected — filename never counts as
  // content; every check reports incomplete coverage
  assert.ok(
    d.uninspected_sources.some((s: any) => s.id === f.assetId),
    "selected asset listed as uninspected",
  );
  for (const q of d.open_questions) {
    assert.equal(
      q.status,
      "not_inspected",
      `${q.kind}: uninspected asset ⇒ coverage is not_inspected`,
    );
  }
  // the asset's filename must not appear as "related text"
  assert.ok(
    !d.open_questions.some((q: any) =>
      q.related.some((r: any) => r.content.includes("monochrome-notes")),
    ),
    "filenames are never scanned for content",
  );

  // H: differing conditions coexist un-merged; identical ones merged
  // (identical merge is covered by the alpha fixture — here the
  // character trait line differs from the item text)
  const constraintTexts = d.constraints.map((s: any) => s.content);
  assert.ok(constraintTexts.includes("髪型: 黒のロングヘア"));
  assert.ok(
    constraintTexts.some((c: string) => c.includes("目の色: 琥珀色")),
    "a differing condition is kept as its own entry",
  );
  assert.ok(
    d.constraints.every((s: any) => s.sources.length >= 1),
    "no constraint loses its provenance",
  );

  // negative policy: nothing found in inspected text AND an
  // uninspected source exists → coverage-limited verdict, NOT a
  // flat "未定"
  const neg = byKind("negative_policy");
  assert.equal(neg.status, "not_inspected");
  assert.equal(neg.related.length, 0);
  assert.match(neg.note, /not inspected|incomplete/i);
});

test("scene draft: scene designation must match the accepted format", async () => {
  const f = await setupFixtureProject("scene-draft-e-formats");
  const tryDoc = async (content: string, title: string) => {
    const d = await f.mkDoc(content, title);
    return draftGet(f.pid, f.bvId, d.rev.id);
  };

  // A: JP + English accepted headings together → multiple targets
  const mixed = await tryDoc(
    "場面1: 朝の駅。少女が立つ。\nScene 2: 夜の家。少女が眠る。",
    "mixed",
  );
  assert.equal(mixed.status, 422);
  assert.match(mixed.json.error, /2 accepted scene headings|target selection/i);

  // A2: accepted + unsupported (numberless シーン) → mixed formats
  const mixedUnsupported = await tryDoc(
    "場面1: 朝の駅。少女が立つ。\nシーン: 夜の家。少女が眠る。",
    "mixed-unsupported",
  );
  assert.equal(mixedUnsupported.status, 422);
  assert.match(mixedUnsupported.json.error, /mixed/i);

  // B: marker only appears inside prose — inline mention is not a
  // line-leading heading
  const inline = await tryDoc(
    "記法の例は「場面:」です。対象場面はまだ決まっていません。",
    "inline",
  );
  assert.equal(inline.status, 422);
  assert.match(inline.json.error, /inline mention|heading/i);

  // C: a bare heading with no body → refuse
  const empty = await tryDoc("場面:", "empty");
  assert.equal(empty.status, 422);
  assert.match(empty.json.error, /no body text/i);

  // heading not at the head of the document → refuse
  const preface = await tryDoc(
    "これは前置きです。\n場面: 駅前。少女が立つ。",
    "preface",
  );
  assert.equal(preface.status, 422);
  assert.match(preface.json.error, /not at the start/i);

  // English: multiple Scene headings still need target selection
  const engMulti = await tryDoc(
    "Scene 1: morning at the station.\nScene 2: night at home.",
    "eng-multi",
  );
  assert.equal(engMulti.status, 422);
  assert.match(engMulti.json.error, /2 accepted scene headings|target selection/i);

  // English: single Scene heading with body is accepted
  const engOk = await tryDoc(
    "Scene 1: morning at the station.\nA girl stands on the platform.",
    "eng-ok",
  );
  assert.equal(engOk.status, 200);
  assert.match(engOk.json.scene.content, /girl stands on the platform/i);

  // English dash form
  const engDash = await tryDoc(
    "Scene 2 - night at home. She sleeps.",
    "eng-dash",
  );
  assert.equal(engDash.status, 200);

  // numberless シーン heading — unsupported
  const head = await tryDoc("シーン: 駅前。少女が立つ。", "head");
  assert.equal(head.status, 422);

  // multiple supported headings → still needs target selection
  const multi = await tryDoc(
    "場面: 朝の駅。少女が立つ。\n場面: 夜の家。少女が寝る。",
    "multi",
  );
  assert.equal(multi.status, 422);
  assert.match(multi.json.error, /target selection/i);

  // no designation at all → cannot confirm single-scene
  const none = await tryDoc("夕方の駅前。少女が立つ。穏やかな光。", "none");
  assert.equal(none.status, 422);

  // accepted: single heading + non-empty multi-line body
  const okLines = await tryDoc(
    "場面: 夜の駅前。\n少女がベンチに座る。\n穏やかな光。",
    "ok-lines",
  );
  assert.equal(okLines.status, 200);
  assert.match(okLines.json.scene.content, /少女がベンチに座る/);

  // accepted: 場面N:
  const okN = await tryDoc("場面3: 夜の駅前。少女が座る。", "ok-n");
  assert.equal(okN.status, 200);

  // accepted: English Scene:
  const okScene = await tryDoc("Scene: night platform. A girl sits.", "ok-scene");
  assert.equal(okScene.status, 200);
});

test("scene draft: unresolvable blueprint references are reported", async () => {
  const f = await setupFixtureProject("scene-draft-unresolved");
  const d1 = await f.mkDoc("場面: 朝の駅。少女が立つ。");
  // fabricate a dangling blueprint reference (as a legacy/corrupt
  // row would leave behind) — FK off only for this fixture step
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    `INSERT INTO blueprint_version_items
       (blueprint_version_id, project_id, item_id, revision_id,
        seq, kind, label)
     VALUES (?, ?, ?, ?, 99, 'other', 'phantom item')`,
  ).run(f.bvId, f.pid, "phantom-item", "no-such-revision");
  db.exec("PRAGMA foreign_keys = ON");

  const res = await draftGet(f.pid, f.bvId, d1.rev.id);
  assert.equal(res.status, 200);
  assert.ok(
    res.json.unresolved_sources.some(
      (u: any) =>
        u.source.id === "no-such-revision" && u.reason === "not_found",
    ),
    "dangling reference is reported, never silently skipped",
  );
  const saved = await api("POST", `/api/projects/${f.pid}/scene-input-drafts`, {
    blueprint_version_id: f.bvId,
    document_id: d1.docId,
    document_revision_id: d1.rev.id,
    digest: res.json.digest,
  });
  assert.equal(saved.status, 201);
  assert.deepEqual(
    saved.json.snapshot.unresolved_sources,
    res.json.unresolved_sources,
  );
});

test("scene draft: base image refs resolve via repo — dangling is reported", async () => {
  const proj = await api("POST", "/api/projects", { name: "sd-baseimg" });
  const pid = proj.json.id;
  const st0 = (await api("GET", `/api/projects/${pid}/state`)).json;
  const adoptItem = async (kind: string, content: string) => {
    const item = st0.items.find((i: any) => i.kind === kind);
    const rev = await api("POST", `/api/items/${item.id}/revisions`, {
      content,
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: rev.json.id,
      expected_version: item.state_version,
    });
  };
  await adoptItem("intent", "静かな一場面");
  await adoptItem("output_policy", "静止画1枚");

  // a real (tiny) PNG as the base image — record exists
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
      "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const img = await api("POST", "/api/assets", {
    owner_kind: "project",
    owner_id: pid,
    kind: "material",
    name: "base.png",
    mime: "image/png",
    content_base64: png.toString("base64"),
  });
  assert.equal(img.status, 201);

  const c1 = await api("POST", "/api/characters", { name: "実在キャラ" });
  const c1rev = await api("POST", `/api/characters/${c1.json.id}/revisions`, {
    profile: { appearance: "黒髪" },
    base_image_asset_id: img.json.id,
  });
  await api("PUT", `/api/projects/${pid}/characters`, {
    character_id: c1.json.id,
    character_revision_id: c1rev.json.id,
    expected_version: null,
  });

  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  const r1 = await api(
    "POST",
    `/api/documents/${doc.json.document.id}/revisions`,
    {
      content: "場面: 駅前。少女が立つ。",
      base_revision_id: doc.json.revision.id,
    },
  );
  const st = (await api("GET", `/api/projects/${pid}/state`)).json;
  const dv = st.documents.find((d: any) => d.id === doc.json.document.id);
  await api("POST", `/api/documents/${doc.json.document.id}/adopt`, {
    revision_id: r1.json.id,
    expected_version: dv.state_version,
  });

  // fabricate a frozen character whose base-image reference dangles
  // (a legacy/corrupt row) — FK off only for this insert, restored
  // in finally. Scratch test DB only.
  const c2 = await api("POST", "/api/characters", { name: "欠落キャラ" });
  const c2rev = await api("POST", `/api/characters/${c2.json.id}/revisions`, {
    profile: { appearance: "茶髪" },
  });
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `INSERT INTO blueprint_version_characters
         (blueprint_version_id, project_id, character_id,
          character_revision_id, base_image_asset_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(bv.json.id, pid, c2.json.id, c2rev.json.id, "bogus-base-image");
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  const res = await draftGet(pid, bv.json.id, r1.json.id);
  assert.equal(res.status, 200);
  const d = res.json;

  // the real base image is a verified RECORD — still not inspected
  const ref = d.ref_assets.find((a: any) => a.id === img.json.id);
  assert.ok(ref, "real base image listed as reference");
  assert.equal(ref.content_inspected, false);
  assert.ok(
    d.uninspected_sources.some((s: any) => s.id === img.json.id),
    "real base image is in the uninspected list",
  );

  // the dangling base image is an UNRESOLVED source — never shown
  // as a verified reference
  assert.ok(
    d.unresolved_sources.some(
      (u: any) =>
        u.source.id === "bogus-base-image" && u.reason === "not_found",
    ),
    "dangling base image reported, not displayed as verified",
  );
  assert.ok(
    !d.ref_assets.some((a: any) => a.id === "bogus-base-image"),
    "dangling base image must not appear in ref_assets",
  );
});

test("generation retry: input dedup, settings split, orphan reconcile", async () => {
  const proj = await api("POST", "/api/projects", { name: "gen-dedup" });
  const pid = proj.json.id;
  let state = (await api("GET", `/api/projects/${pid}/state`)).json;
  const purpose = state.items.find((i: any) => i.kind === "purpose");
  const pr = await api("POST", `/api/items/${purpose.id}/revisions`, {
    content: "物語",
  });
  await api("POST", `/api/items/${purpose.id}/adopt`, {
    revision_id: pr.json.id,
    expected_version: purpose.state_version,
  });
  state = (await api("GET", `/api/projects/${pid}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = state.items.find((i: any) => i.kind === kind);
    const r = await api("POST", `/api/items/${item.id}/revisions`, {
      content: `${kind} content`,
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: r.json.id,
      expected_version: item.state_version,
    });
  }
  const bv = await api("POST", `/api/projects/${pid}/blueprint-versions`, {});
  const doc = await api("POST", `/api/projects/${pid}/documents`, {
    kind: "script",
    blueprint_version_id: bv.json.id,
  });
  const docId = doc.json.document.id;
  const docRevId = doc.json.revision.id;
  state = (await api("GET", `/api/projects/${pid}/state`)).json;
  const script = state.documents.find((d: any) => d.id === docId);
  await api("POST", `/api/documents/${docId}/adopt`, {
    revision_id: docRevId,
    expected_version: script.state_version,
  });
  const genBody = { blueprint_version_id: bv.json.id, kind: "image" };

  // a first real submit gives us the exact stored input snapshot
  const first = await api("POST", `/api/projects/${pid}/generations`, genBody);
  const inputs = JSON.parse(
    (await api("GET", `/api/generations/${first.json.id}`)).json.inputs,
  );
  assert.equal(first.json.status, "succeeded");

  // in-flight record carrying the IDENTICAL snapshot → a retry POST
  // re-attaches; nothing new is submitted
  const inflightId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO generation_records
       (id, project_id, kind, status, blueprint_version_id,
        document_revision_id, inputs, backend, backend_job_id, created_at)
     VALUES (?, ?, 'image', 'running', ?, ?, ?, 'comfy-sdk', 'job-x', datetime('now'))`,
  ).run(inflightId, pid, bv.json.id, docRevId, JSON.stringify(inputs));
  const before = genSubmits;
  const retry = await api("POST", `/api/projects/${pid}/generations`, genBody);
  assert.equal(retry.status, 200);
  assert.equal(
    retry.json.id,
    inflightId,
    "retry re-attaches to the in-flight record",
  );
  assert.equal(genSubmits, before, "no second backend submission");

  // a CHANGED setting produces a different snapshot — it must never
  // merge into the in-flight job
  const other = await api("POST", `/api/projects/${pid}/generations`, {
    ...genBody,
    duration_seconds: 5,
  });
  assert.equal(other.status, 200);
  assert.notEqual(other.json.id, inflightId);
  assert.equal(
    genSubmits,
    before + 1,
    "different input is a distinct submission",
  );

  // concurrent POSTs of the same payload → exactly one record + one
  // submit (IMMEDIATE txn serializes match-or-insert)
  const proj2 = await api("POST", "/api/projects", { name: "gen-race" });
  const pid2 = proj2.json.id;
  let s2 = (await api("GET", `/api/projects/${pid2}/state`)).json;
  const p2 = s2.items.find((i: any) => i.kind === "purpose");
  const p2r = await api("POST", `/api/items/${p2.id}/revisions`, {
    content: "物語",
  });
  await api("POST", `/api/items/${p2.id}/adopt`, {
    revision_id: p2r.json.id,
    expected_version: p2.state_version,
  });
  s2 = (await api("GET", `/api/projects/${pid2}/state`)).json;
  for (const kind of ["intent", "output_policy"]) {
    const item = s2.items.find((i: any) => i.kind === kind);
    const r = await api("POST", `/api/items/${item.id}/revisions`, {
      content: `${kind} content`,
    });
    await api("POST", `/api/items/${item.id}/adopt`, {
      revision_id: r.json.id,
      expected_version: item.state_version,
    });
  }
  const bv2 = await api("POST", `/api/projects/${pid2}/blueprint-versions`, {});
  const doc2 = await api("POST", `/api/projects/${pid2}/documents`, {
    kind: "script",
    blueprint_version_id: bv2.json.id,
  });
  s2 = (await api("GET", `/api/projects/${pid2}/state`)).json;
  const script2 = s2.documents.find((d: any) => d.id === doc2.json.document.id);
  await api("POST", `/api/documents/${doc2.json.document.id}/adopt`, {
    revision_id: doc2.json.revision.id,
    expected_version: script2.state_version,
  });
  const body2 = { blueprint_version_id: bv2.json.id, kind: "image" };
  const before2 = genSubmits;
  // a controlled slow backend holds the first submit in-flight so the
  // second POST meets the record mid-flight every time
  const origSubmit2 = gen.submit;
  gen.submit = async (...args: Parameters<MockGenerationBackend["submit"]>) => {
    await new Promise((r) => setTimeout(r, 300));
    return origSubmit2(...args);
  };
  const [r1, r2] = await Promise.all([
    api("POST", `/api/projects/${pid2}/generations`, body2),
    api("POST", `/api/projects/${pid2}/generations`, body2),
  ]);
  gen.submit = origSubmit2;
  assert.equal(
    r1.json.id,
    r2.json.id,
    "concurrent POSTs resolve to one record",
  );
  const stEnd = (await api("GET", `/api/projects/${pid2}/state`)).json;
  const same = stEnd.generations.filter(
    (g: any) => g.blueprint_version_id === bv2.json.id,
  );
  assert.equal(same.length, 1, "one generation record");
  assert.equal(genSubmits - before2, 1, "one backend submission");

  // response lost after a possible accept: queued + no job id stays
  // queued until an authoritative same-correlation lookup finds it.
  // Absence must not trigger any submit or a new key.
  const orphanId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO generation_records
       (id, project_id, kind, status, blueprint_version_id,
        document_revision_id, inputs, backend, backend_job_id, created_at)
     VALUES (?, ?, 'image', 'queued', ?, ?, ?, 'comfy-sdk', NULL, '2020-01-01 00:00:00')`,
  ).run(orphanId, pid, bv.json.id, docRevId, JSON.stringify(inputs));
  const beforeOrphan = genSubmits;
  const reconciled = await api("GET", `/api/generations/${orphanId}`);
  assert.equal(reconciled.json.status, "queued");
  assert.equal(reconciled.json.backend_job_id, null);
  assert.equal(genSubmits, beforeOrphan, "unconfirmed orphan must never be resubmitted blindly");
});


test("uncertain accept and first-poll transport failure retain correlation without resubmission", async () => {
  const originalSubmit = gen.submit, originalPoll = gen.poll;
  const recovery = gen as typeof gen & { findJob?: () => Promise<GenerationJob | null> };
  const originalFind = recovery.findJob;
  try {
    for (const mode of ["lost", "poll", "rejected"] as const) {
      const { pid, bvId, doc, rev0 } = await setupDocProject(`recovery-${mode}`);
      await api("POST", `/api/documents/${doc.id}/adopt`, { revision_id: rev0.id, expected_version: doc.state_version });
      let submits = 0, firstPoll = true, located = false, accepted: GenerationJob | null = null;
      gen.submit = async (...args) => {
        submits++;
        if (mode === "rejected") throw new GenerationRejectedError("invalid workflow fixture");
        accepted = await originalSubmit(...args);
        if (mode === "lost") throw new Error("accept response lost");
        return accepted;
      };
      gen.poll = async (...args) => {
        if (mode === "poll" && firstPoll) { firstPoll = false; throw new Error("temporary poll network failure"); }
        return originalPoll(...args);
      };
      recovery.findJob = async () => located ? accepted : null;
      const body = { blueprint_version_id: bvId, document_revision_id: rev0.id, kind: "image" };
      const first = await api("POST", `/api/projects/${pid}/generations`, body);
      assert.equal(first.json.status, mode === "rejected" ? "failed" : mode === "lost" ? "queued" : "running");
      if (mode === "rejected") { assert.match(first.json.error, /invalid workflow/); continue; }
      if (mode === "lost") {
        const duplicate = await api("POST", `/api/projects/${pid}/generations`, body);
        assert.equal(duplicate.json.id, first.json.id); assert.equal(duplicate.json.status, "queued");
        assert.equal(submits, 1); located = true;
      }
      const done = await api("GET", `/api/generations/${first.json.id}`);
      assert.equal(done.json.status, "succeeded"); assert.equal(done.json.backend_job_id, accepted!.backend_job_id);
      assert.equal(done.json.error, null); assert.equal(submits, 1);
    }
  } finally { gen.submit = originalSubmit; gen.poll = originalPoll; recovery.findJob = originalFind; }
});

test("public character pin requires a version and rejects stale and ABA updates", async () => {
  const p = await api("POST", "/api/projects", { name: "pin-cas" });
  const c = await api("POST", "/api/characters", { name: "pin-cas" });
  const r1 = await api("POST", `/api/characters/${c.json.id}/revisions`, { profile: {} });
  const r2 = await api("POST", `/api/characters/${c.json.id}/revisions`, { profile: {} });
  const path = `/api/projects/${p.json.id}/characters`;
  const body = { character_id: c.json.id, character_revision_id: r1.json.id };
  assert.equal((await api("PUT", path, body)).status, 400);
  assert.equal((await api("PUT", path, { ...body, expected_version: null })).json.pin_version, 1);
  assert.equal((await api("PUT", path, { ...body, character_revision_id: r2.json.id, expected_version: 1 })).json.pin_version, 2);
  assert.equal((await api("PUT", path, { ...body, expected_version: 1 })).status, 409);
  assert.equal((await api("PUT", path, { ...body, expected_version: 2 })).json.pin_version, 3);
  assert.equal((await api("PUT", path, { ...body, expected_version: 1 })).status, 409);
});


test("asset selection API requires expected_version and returns 409 without stale writes", async () => {
  const p = await api("POST", "/api/projects", { name: "asset-cas" });
  const a = await api("POST", "/api/assets", { owner_kind: "project", owner_id: p.json.id, kind: "material", name: "fixture.txt", mime: "text/plain", content_base64: Buffer.from("fixture").toString("base64") });
  assert.equal(a.status, 201);
  const path = `/api/assets/${a.json.id}/select`;
  assert.equal((await api("POST", path, { selected: true })).status, 400);
  assert.equal((await api("POST", path, { selected: true, expected_version: 0 })).json.selection_version, 1);
  assert.equal((await api("POST", path, { selected: false, expected_version: 0 })).status, 409);
  const state = (await api("GET", `/api/projects/${p.json.id}/state`)).json;
  assert.equal(state.assets.find((x: any) => x.id === a.json.id).selected, 1);
});


test("verbatim workflow reproduction requires exact approved document and preserves template literals", async () => {
 const subject = "Official template subject";
 const p = await api("POST", "/api/projects", { name: "verbatim-baseline" }); const pid = p.json.id;
 const state = (await api("GET", `/api/projects/${pid}/state`)).json;
 for (const kind of ["intent", "output_policy"]) {
  const item = state.items.find((i: any) => i.kind === kind);
  const r = await api("POST", `/api/items/${item.id}/revisions`, { content: kind === "intent" ? subject : "Original workflow settings" });
  await api("POST", `/api/items/${item.id}/adopt`, { revision_id: r.json.id, expected_version: item.state_version });
 }
 // adopted camera_work must not break verbatim reproduction nor reach it
 const cwItem = state.items.find((i: any) => i.kind === "camera_work");
 const cwr = await api("POST", `/api/items/${cwItem.id}/revisions`, { content: "deliberate crane move" });
 await api("POST", `/api/items/${cwItem.id}/adopt`, { revision_id: cwr.json.id, expected_version: cwItem.state_version });
 const bvId = (await api("POST", `/api/projects/${pid}/blueprint-versions`, {})).json.id;
 const created = (await api("POST", `/api/projects/${pid}/documents`, { kind: "script", blueprint_version_id: bvId })).json;
 const doc = created.document;
 const rev0 = (await api("POST", `/api/documents/${doc.id}/revisions`, { content: subject, base_revision_id: created.revision.id })).json;
 await api("POST", `/api/documents/${doc.id}/adopt`, { revision_id: rev0.id, expected_version: doc.state_version });
 const graph = { p: { class_type: "PrimitiveStringMultiline", inputs: { value: rev0.content } }, sampler: { class_type: "Fixture", inputs: { seed: 987654, steps: 25, cfg: 2.5 } }, out: { class_type: "SaveImage", inputs: { image: ["sampler", 0] } } };
 const selection = { name: "baseline.json", kind: "image", graph, prompt: { node: "p", input: "value" }, prompt_verbatim: true, output_node: "out", settings: {}, values: [] };
 const path = `/api/projects/${pid}/generation-selection`;
 assert.equal((await api("PUT", path, { expected_version: 0, selection })).status, 200);
 const body = { blueprint_version_id: bvId, document_revision_id: rev0.id, kind: "image", selection_version: 1 };
 const done = await api("POST", `/api/projects/${pid}/generations`, body);
 assert.equal(done.json.status, "succeeded");
 const input = JSON.parse(done.json.inputs); assert.equal(input.prompt, rev0.content); assert.equal(input.settings.seed, undefined);
 assert.deepEqual(input.settings.workflow_selection.graph, graph);
 selection.graph.p.inputs.value = "unapproved different subject";
 await api("PUT", path, { expected_version: 1, selection });
 const before = genSubmits;
 assert.equal((await api("POST", `/api/projects/${pid}/generations`, { ...body, selection_version: 2 })).status, 422);
 assert.equal(genSubmits, before);
});


test("verbatim reproduction cannot omit approved blueprint direction", async () => {
 const { pid, bvId, doc, rev0 } = await setupDocProject("verbatim-direction");
 await api("POST", `/api/documents/${doc.id}/adopt`, { revision_id: rev0.id, expected_version: doc.state_version });
 const selection = { name: "baseline.json", kind: "image", graph: { p: { class_type: "PrimitiveStringMultiline", inputs: { value: rev0.content } }, out: { class_type: "SaveImage", inputs: {} } }, prompt: { node: "p", input: "value" }, prompt_verbatim: true, output_node: "out", values: [] };
 await api("PUT", `/api/projects/${pid}/generation-selection`, { expected_version: 0, selection });
 const before = genSubmits;
 const res = await api("POST", `/api/projects/${pid}/generations`, { blueprint_version_id: bvId, document_revision_id: rev0.id, kind: "image", selection_version: 1 });
 assert.equal(res.status, 422); assert.match(res.json.error, /approved blueprint content/); assert.equal(genSubmits, before);
});

test("poll distinguishes missing remote job from transport failure", async () => {
  const proj = await api("POST", "/api/projects", { name: "stale-poll" });
  const pid = proj.json.id;
  const ins = (id: string, jobId: string) =>
    db.prepare(
      `INSERT INTO generation_records
         (id, project_id, kind, status, inputs, backend, backend_job_id, created_at)
       VALUES (?, ?, 'image', 'running', '{}', 'mock', ?, datetime('now'))`,
    ).run(id, pid, jobId);
  const missingId = crypto.randomUUID();
  const downId = crypto.randomUUID();
  ins(missingId, "missing:x");
  ins(downId, "down:x");
  const submitsBefore = genSubmits;

  const miss = await api("GET", `/api/generations/${missingId}`);
  assert.equal(miss.json.status, "running");
  assert.match(miss.json.error, /not found/i);
  assert.match(miss.json.error, /no automatic resubmit/i);

  const down = await api("GET", `/api/generations/${downId}`);
  assert.equal(down.json.status, "running");
  assert.match(down.json.error, /Poll unavailable/i);

  // neither path issues a new backend submission
  assert.equal(genSubmits, submitsBefore);
});

test("poll transport failure → explicit re-poll recovers the same job (ST2 mock)", async () => {
  const proj = await api("POST", "/api/projects", { name: "st2-recover" });
  const pid = proj.json.id;
  const file = join(mkdtempSync(join(tmpdir(), "vo-st2-")), `flaky-out-${pid}.png`);
  writeFileSync(file, Buffer.from("stub"));
  const gid = crypto.randomUUID();
  db.prepare(
    `INSERT INTO generation_records
       (id, project_id, kind, status, inputs, backend, backend_job_id, created_at)
     VALUES (?, ?, 'image', 'running', '{}', 'mock', ?, datetime('now'))`,
  ).run(gid, pid, `flaky1:${file}`);
  const submitsBefore = genSubmits;

  const first = await api("GET", `/api/generations/${gid}`);
  assert.equal(first.json.status, "running");
  assert.match(first.json.error, /Poll unavailable/i);

  // A reachable backend may still be running after transport recovery.
  // Reuse the existing fixture without adding a SQL setup path.
  const originalPoll = gen.poll;
  gen.poll = async (job, ctx) => job.backend_job_id === first.json.backend_job_id
    ? { status: "running" }
    : originalPoll.call(gen, job, ctx);
  try {
    const resumed = await api("GET", `/api/generations/${gid}`);
    assert.equal(resumed.json.status, "running");
    assert.equal(resumed.json.id, gid);
    assert.equal(resumed.json.backend_job_id, first.json.backend_job_id);
    assert.equal(resumed.json.error, null);
    assert.equal(resumed.json.output_asset_id, null);
    const state = await api("GET", `/api/projects/${pid}/state`);
    assert.equal(state.json.generations[0].error, null);
  } finally {
    gen.poll = originalPoll;
  }

  // Re-poll the same job to completion, without another submit.
  const second = await api("GET", `/api/generations/${gid}`);
  assert.equal(second.json.status, "succeeded");
  assert.equal(second.json.id, gid);
  assert.ok(second.json.output_asset_id);
  assert.equal(genSubmits, submitsBefore);
});

test("project/version switching keeps generations and assets isolated (ST4 mock)", async () => {
  const mk = async (name: string) => {
    const p = await api("POST", "/api/projects", { name });
    const st = (await api("GET", `/api/projects/${p.json.id}/state`)).json;
    for (const kind of ["intent", "output_policy"]) {
      const item = st.items.find((i: any) => i.kind === kind);
      const r = await api("POST", `/api/items/${item.id}/revisions`, {
        content: `${name} ${kind}`,
      });
      await api("POST", `/api/items/${item.id}/adopt`, {
        revision_id: r.json.id,
        expected_version: item.state_version,
      });
    }
    const bv = await api(
      "POST",
      `/api/projects/${p.json.id}/blueprint-versions`,
      {},
    );
    const doc = await api("POST", `/api/projects/${p.json.id}/documents`, {
      kind: "script",
      blueprint_version_id: bv.json.id,
    });
    const st2 = (await api("GET", `/api/projects/${p.json.id}/state`)).json;
    const d = st2.documents.find((x: any) => x.id === doc.json.document.id);
    await api("POST", `/api/documents/${d.id}/adopt`, {
      revision_id: doc.json.revision.id,
      expected_version: d.state_version,
    });
    const g = await api(
      "POST",
      `/api/projects/${p.json.id}/generations`,
      { blueprint_version_id: bv.json.id, kind: "image" },
    );
    assert.equal(g.json.status, "succeeded");
    return { pid: p.json.id, gid: g.json.id, out: g.json.output_asset_id };
  };
  const A = await mk("proj-a");
  const B = await mk("proj-b");
  const sa = (await api("GET", `/api/projects/${A.pid}/state`)).json;
  const sb = (await api("GET", `/api/projects/${B.pid}/state`)).json;
  assert.deepEqual(
    sa.generations.map((g: any) => g.id),
    [A.gid],
  );
  assert.deepEqual(
    sb.generations.map((g: any) => g.id),
    [B.gid],
  );
  assert.ok(sa.assets.every((a: any) => a.id !== B.out));
  assert.ok(sb.assets.every((a: any) => a.id !== A.out));
});
