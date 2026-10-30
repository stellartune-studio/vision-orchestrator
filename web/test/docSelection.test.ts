import test from "node:test";
import assert from "node:assert/strict";
import type {
  DocumentRevision,
  DocumentView,
  GenerationRecord,
  ProjectState,
} from "@vo/shared";
import {
  chosenRevisionId,
  docCandidatesFor,
  resolveDocChoice,
  retryBlockReason,
} from "../src/features/docSelection.ts";

function rev(
  id: string,
  docId: string,
  revNo: number,
  bvId: string | null,
  status: DocumentRevision["proposal_status"],
): DocumentRevision {
  return {
    id,
    document_id: docId,
    rev_no: revNo,
    content: `content of ${id}`,
    source: "user",
    blueprint_version_id: bvId,
    proposal_status: status,
    base_state_version: 0,
    created_at: "2026-10-17",
  };
}

function doc(
  id: string,
  title: string,
  adoptedRevId: string | null,
  revisions: DocumentRevision[],
): DocumentView {
  const adopted = revisions.find((r) => r.id === adoptedRevId) ?? null;
  return {
    id,
    project_id: "p1",
    kind: "script",
    title,
    adopted_revision_id: adoptedRevId,
    state_version: 1,
    created_at: "2026-10-17",
    adoption: adopted ? "adopted" : "undecided",
    consistency: "in_sync",
    adopted_revision: adopted,
    pending_proposals: revisions.filter(
      (r) => r.proposal_status === "pending",
    ),
    revisions,
  };
}

function state(docs: DocumentView[]): ProjectState {
  return {
    project: {
      id: "p1",
      name: "t",
      purpose_note: null,
      template_key: null,
      template_version: null,
      created_at: "2026-10-17",
      updated_at: "2026-10-17",
    },
    items: [],
    messages: [],
    blueprint_versions: [],
    documents: docs,
    characters: [],
    character_views: [],
    assets: [],
    generations: [],
  };
}

// ---- docCandidatesFor / resolveDocChoice ----

test("candidates: only adopted revisions derived from the version", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const r2 = rev("r2", "docB", 1, "bv2", "adopted"); // other version
  const r3 = rev("r3", "docC", 1, "bv1", "pending"); // not adopted
  const st = state([
    doc("docA", "台本A", "r1", [r1]),
    doc("docB", "", "r2", [r2]),
    doc("docC", "", null, [r3]),
  ]);
  const c = docCandidatesFor(st, "bv1");
  assert.equal(c.length, 1);
  assert.equal(c[0].rev.id, "r1");
});

test("choice: single candidate resolves automatically", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const st = state([doc("docA", "", "r1", [r1])]);
  const res = resolveDocChoice(
    docCandidatesFor(st, "bv1"),
    null,
    st.documents,
  );
  assert.equal(res.kind, "auto");
  assert.equal(chosenRevisionId(res), "r1");
});

test("choice: several candidates without a pick stay unselected", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const r2 = rev("r2", "docB", 1, "bv1", "adopted");
  const st = state([doc("docA", "", "r1", [r1]), doc("docB", "", "r2", [r2])]);
  const res = resolveDocChoice(
    docCandidatesFor(st, "bv1"),
    null,
    st.documents,
  );
  assert.equal(res.kind, "unselected");
  assert.equal(chosenRevisionId(res), null);
});

test("choice: picked revision resolves while it stays adopted", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const r2 = rev("r2", "docB", 1, "bv1", "adopted");
  const st = state([doc("docA", "", "r1", [r1]), doc("docB", "", "r2", [r2])]);
  const res = resolveDocChoice(
    docCandidatesFor(st, "bv1"),
    "r2",
    st.documents,
  );
  assert.equal(res.kind, "chosen");
  assert.equal(chosenRevisionId(res), "r2");
});

test("choice: adoption moving to another revision marks the pick stale — no silent swap", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const r2new = rev("r2", "docA", 2, "bv1", "adopted");
  // picked r1, then adoption moved to r2 (same document!)
  const st = state([doc("docA", "", "r2", [r1, r2new])]);
  const res = resolveDocChoice(
    docCandidatesFor(st, "bv1"),
    "r1",
    st.documents,
  );
  assert.equal(res.kind, "stale");
  if (res.kind === "stale") assert.equal(res.pickedRev?.id, "r1");
  assert.equal(chosenRevisionId(res), null);
});

test("choice: auto-picked revision committed, then adoption moves → stale, not silent swap", () => {
  // Regression for the auto-commit rule: a single candidate resolves
  // as "auto", the UI commits that revision id as the pick, and a
  // later refresh where adoption moved to a newer revision of the
  // same document MUST surface as stale — never follow along.
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const st1 = state([doc("docA", "", "r1", [r1])]);
  const first = resolveDocChoice(
    docCandidatesFor(st1, "bv1"),
    null,
    st1.documents,
  );
  assert.equal(first.kind, "auto");
  const committed = chosenRevisionId(first);
  assert.equal(committed, "r1");

  // server-side: revision #2 adopted for the same document
  const r1sup = { ...r1, proposal_status: "superseded" as const };
  const r2 = rev("r2", "docA", 2, "bv1", "adopted");
  const st2 = state([doc("docA", "", "r2", [r1sup, r2])]);
  const next = resolveDocChoice(
    docCandidatesFor(st2, "bv1"),
    committed,
    st2.documents,
  );
  assert.equal(next.kind, "stale");
  assert.equal(chosenRevisionId(next), null);

  // explicit re-pick of the new candidate clears the stale state
  const repick = resolveDocChoice(
    docCandidatesFor(st2, "bv1"),
    "r2",
    st2.documents,
  );
  assert.equal(repick.kind, "chosen");
  assert.equal(chosenRevisionId(repick), "r2");
});

test("choice: picked revision gone entirely is stale too", () => {
  const st = state([doc("docA", "", null, [])]);
  const res = resolveDocChoice(
    docCandidatesFor(st, "bv1"),
    "r-gone",
    st.documents,
  );
  assert.equal(res.kind, "stale");
  assert.equal(chosenRevisionId(res), null);
});

// ---- retryBlockReason ----

function genRecord(over: Partial<GenerationRecord>): GenerationRecord {
  return {
    id: "g1",
    project_id: "p1",
    kind: "image",
    status: "failed",
    blueprint_version_id: "bv1",
    document_revision_id: "r1",
    inputs: "{}",
    backend: "mock",
    backend_job_id: null,
    output_asset_id: null,
    error: "x",
    created_at: "2026-10-17",
    updated_at: "2026-10-17",
    ...over,
  };
}

test("retry: identical conditions pass", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const docs = [doc("docA", "", "r1", [r1])];
  assert.equal(
    retryBlockReason(genRecord({}), docs),
    null,
  );
});

test("retry: record without document_revision_id is blocked — never auto-resolve", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const docs = [doc("docA", "", "r1", [r1])];
  const reason = retryBlockReason(
    genRecord({ document_revision_id: null }),
    docs,
  );
  assert.match(reason ?? "", /no document version stored for generation/);
});

test("retry: record without blueprint_version_id is blocked", () => {
  const docs: DocumentView[] = [];
  const reason = retryBlockReason(
    genRecord({ blueprint_version_id: null }),
    docs,
  );
  assert.match(reason ?? "", /no blueprint version stored for retry/);
});

test("retry: recorded revision no longer adopted is blocked", () => {
  const r1 = rev("r1", "docA", 1, "bv1", "adopted");
  const r2 = rev("r2", "docA", 2, "bv1", "adopted");
  const docs = [doc("docA", "", "r2", [r1, r2])]; // r2 adopted now
  const reason = retryBlockReason(genRecord({}), docs);
  assert.match(reason ?? "", /not the currently approved version/);
});

test("retry: revision re-based to another version is blocked", () => {
  const r1 = rev("r1", "docA", 1, "bv2", "adopted"); // different bv
  const docs = [doc("docA", "", "r1", [r1])];
  const reason = retryBlockReason(genRecord({}), docs);
  assert.match(reason ?? "", /no longer comes from the target blueprint version/);
});

test("retry: revision vanished from state is blocked", () => {
  const docs = [doc("docA", "", null, [])];
  const reason = retryBlockReason(genRecord({}), docs);
  assert.match(reason ?? "", /not available in the current state/);
});
