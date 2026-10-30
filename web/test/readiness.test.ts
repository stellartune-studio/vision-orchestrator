import test from "node:test";
import assert from "node:assert/strict";
import type {
  BlueprintVersion,
  BlueprintVersionDetail,
  DocumentView,
  ItemView,
  ProjectState,
  ServerMeta,
} from "@vo/shared";
import {
  blueprintDrifted,
  buildReadiness,
  detailForReadiness,
  readinessReady,
} from "../src/features/readiness.ts";

const META: ServerMeta = {
  node: "v24.22.0",
  llm_provider: "mock",
  gen_backend: "mock",
  gen_kinds: ["image"],
  mock: true,
};

const BV: BlueprintVersion = {
  id: "bv1",
  project_id: "p1",
  version_no: 1,
  note: null,
  template_key: null,
  template_version: null,
  created_at: "2026-10-17",
};

function item(kind: ItemView["kind"], adopted: boolean): ItemView {
  return {
    id: `it-${kind}`,
    project_id: "p1",
    kind,
    seq: 0,
    parent_item_id: null,
    label: kind,
    adopted_revision_id: adopted ? "rev" : null,
    state_version: 0,
    created_at: "2026-10-17",
    adoption: adopted ? "adopted" : "undecided",
    adopted_revision: adopted
      ? {
          id: `rev-${kind}`,
          item_id: `it-${kind}`,
          rev_no: 1,
          content: "content",
          source: "user",
          proposal_status: "adopted",
          base_state_version: 0,
          created_at: "2026-10-17",
        }
      : null,
    pending_proposals: [],
    stale_proposal_count: 0,
    revisions: [],
  };
}

function approvedDoc(bvId: string): DocumentView {
  return {
    id: "doc1",
    project_id: "p1",
    kind: "script",
    title: "",
    adopted_revision_id: "drev1",
    state_version: 1,
    created_at: "2026-10-17",
    adoption: "adopted",
    consistency: "in_sync",
    adopted_revision: {
      id: "drev1",
      document_id: "doc1",
      rev_no: 1,
      content: "script",
      source: "llm",
      blueprint_version_id: bvId,
      proposal_status: "adopted",
      base_state_version: 0,
      created_at: "2026-10-17",
    },
    pending_proposals: [],
    revisions: [],
  };
}

function state(over: Partial<ProjectState>): ProjectState {
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
    documents: [],
    characters: [],
    character_views: [],
    assets: [],
    generations: [],
    ...over,
  };
}

const READY_DETAIL: BlueprintVersionDetail = {
  ...BV,
  items: [
    {
      blueprint_version_id: "bv1",
      item_id: "it-intent",
      revision_id: "r1",
      seq: 0,
      parent_item_id: null,
      kind: "intent",
      label: "intent",
    },
    {
      blueprint_version_id: "bv1",
      item_id: "it-output_policy",
      revision_id: "r2",
      seq: 1,
      parent_item_id: null,
      kind: "output_policy",
      label: "output",
    },
  ],
  characters: [],
  assets: [],
};

test("no version: missing gate, not ready", () => {
  const r = buildReadiness(state({}), META, null);
  assert.equal(readinessReady(r), false);
  assert.ok(r.some((i) => i.tone === "missing"));
});

test("detail loading: pending guidance, never claimed ready", () => {
  const r = buildReadiness(state({ blueprint_versions: [BV] }), META, undefined);
  assert.ok(r.some((i) => i.tone === "pending"));
  assert.equal(readinessReady(r), false);
});

test("detail fetch failure: reported as unverifiable, not as generatable", () => {
  const st = state({
    blueprint_versions: [BV],
    documents: [approvedDoc("bv1")],
    items: [item("intent", true), item("output_policy", true)],
  });
  const r = buildReadiness(st, META, "error");
  const failed = r.find((i) => i.tone === "missing");
  assert.ok(failed, "error must surface a blocking readiness item");
  assert.match(failed.label, /Could not check version contents/);
  assert.equal(readinessReady(r), false);
});

test("detailForReadiness keeps loading/error distinct from real data", () => {
  assert.equal(detailForReadiness(false, "ready", null), null);
  assert.equal(detailForReadiness(true, "loading", null), undefined);
  assert.equal(detailForReadiness(true, "error", null), "error");
  assert.equal(
    detailForReadiness(true, "ready", READY_DETAIL),
    READY_DETAIL,
  );
});

test("ready detail + approved doc from this version: ready", () => {
  const st = state({
    blueprint_versions: [BV],
    documents: [approvedDoc("bv1")],
    items: [item("intent", true), item("output_policy", true)],
  });
  const r = buildReadiness(st, META, READY_DETAIL);
  assert.equal(readinessReady(r), true);
});

test("approved doc exists but from another version: still missing", () => {
  const st = state({
    blueprint_versions: [BV],
    documents: [approvedDoc("other-bv")],
    items: [item("intent", true), item("output_policy", true)],
  });
  const r = buildReadiness(st, META, READY_DETAIL);
  assert.equal(readinessReady(r), false);
});

// ---- blueprintDrifted: snapshot vs live blueprint comparison ----

function adopted(
  id: string,
  revisionId: string,
  seq = 0,
  parent: string | null = null,
): ItemView {
  const v = item("intent", true);
  return {
    ...v,
    id,
    seq,
    parent_item_id: parent,
    adopted_revision_id: revisionId,
    adopted_revision: v.adopted_revision
      ? { ...v.adopted_revision, id: revisionId, item_id: id }
      : null,
  };
}

const DRIFT_DETAIL: BlueprintVersionDetail = {
  ...BV,
  items: [
    {
      blueprint_version_id: "bv1",
      item_id: "it-a",
      revision_id: "rA",
      seq: 0,
      parent_item_id: null,
      kind: "story_segment",
      label: "seg1",
    },
    {
      blueprint_version_id: "bv1",
      item_id: "it-b",
      revision_id: "rB",
      seq: 1,
      parent_item_id: "it-a",
      kind: "shot",
      label: "shot1",
    },
  ],
  characters: [
    {
      blueprint_version_id: "bv1",
      character_id: "ch1",
      character_revision_id: "cr1",
      base_image_asset_id: null,
    },
  ],
  assets: [
    {
      blueprint_version_id: "bv1",
      asset_id: "as1",
      role: "material",
    },
  ],
};

const DRIFT_STATE = () =>
  state({
    blueprint_versions: [BV],
    items: [adopted("it-a", "rA", 0), adopted("it-b", "rB", 1, "it-a")],
    characters: [
      {
        project_id: "p1",
        character_id: "ch1",
        character_revision_id: "cr1",
        created_at: "2026-10-17",
      },
    ],
    assets: [
      {
        id: "as1",
        owner_kind: "project",
        owner_id: "p1",
        kind: "material",
        path: "x.png",
        mime: "image/png",
        sha256: null,
        meta: null,
        selected: 1,
        created_at: "2026-10-17",
      },
    ],
  });

test("drift: identical state is not drifted", () => {
  assert.equal(blueprintDrifted(DRIFT_DETAIL, DRIFT_STATE()), false);
});

test("drift: reordered item flags the version", () => {
  const st = DRIFT_STATE();
  st.items = [adopted("it-a", "rA", 5), adopted("it-b", "rB", 1, "it-a")];
  assert.equal(blueprintDrifted(DRIFT_DETAIL, st), true);
});

test("drift: parent-link change flags the version", () => {
  const st = DRIFT_STATE();
  st.items = [adopted("it-a", "rA", 0), adopted("it-b", "rB", 1, null)];
  assert.equal(blueprintDrifted(DRIFT_DETAIL, st), true);
});

test("drift: character re-pin flags the version", () => {
  const st = DRIFT_STATE();
  st.characters = [{ ...st.characters[0], character_revision_id: "cr2" }];
  assert.equal(blueprintDrifted(DRIFT_DETAIL, st), true);
});

test("drift: deselected asset flags the version", () => {
  const st = DRIFT_STATE();
  st.assets = [{ ...st.assets[0], selected: 0 }];
  assert.equal(blueprintDrifted(DRIFT_DETAIL, st), true);
});

test("drift: newly adopted item flags; undecided item does not", () => {
  const st = DRIFT_STATE();
  st.items = [...st.items, adopted("it-c", "rC", 2)];
  assert.equal(blueprintDrifted(DRIFT_DETAIL, st), true);
  const st2 = DRIFT_STATE();
  st2.items = [...st2.items, item("worldview", false)];
  assert.equal(blueprintDrifted(DRIFT_DETAIL, st2), false);
});
