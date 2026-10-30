// Shared helpers for the scene-draft verification pair (seed.mjs /
// verify.mjs). Both scripts MUST establish the mock-only guarantee on
// their own — never rely on the other script having checked first.

import {
  existsSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { checkScratchDataDir } from "../data-dir-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");

/** Default manifest location — an OS-temp file, not the source tree. */
export const defaultManifestPath = () =>
  process.env.VO_MANIFEST ||
  join(tmpdir(), "vo-scene-draft-manifest.json");

// ---------------------------------------------------------------- mock gate

/** GET `<base>/api/meta`; resolve only when BOTH integrations report
 *  "mock". Anything else — HTTP error, bad JSON, a real provider —
 *  is a refusal. meta.mock alone is never enough. */
async function assertMockOrigin(name, base) {
  const meta = `${base}/api/meta`;
  let res;
  try {
    res = await fetch(meta, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    return `${name}: ${meta} unreachable (${err?.cause?.code ?? err?.message})`;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return `${name}: ${meta} did not return JSON`;
  }
  if (!res.ok) {
    return `${name}: ${meta} HTTP ${res.status}`;
  }
  const llm = body?.llm_provider;
  const gen = body?.gen_backend;
  if (llm !== "mock" || gen !== "mock") {
    return `${name}: ${meta} reports llm_provider=${JSON.stringify(llm)} ` +
      `gen_backend=${JSON.stringify(gen)} — both must be "mock"`;
  }
  return null;
}

/** Both origins must report mock. Returns {ok, reasons} — the caller
 *  decides whether to refuse. NOTHING may be written before this
 *  resolves ok. */
export async function assertMockEndpoints({ api, web }) {
  const reasons = (
    await Promise.all([
      assertMockOrigin("VO_API", api),
      assertMockOrigin("VO_WEB", web),
    ])
  ).filter(Boolean);
  return { ok: reasons.length === 0, reasons };
}

/** Refuse-and-exit wrapper for the scripts' entry points. */
export async function requireMockEndpoints(env) {
  const gate = await assertMockEndpoints(env);
  if (!gate.ok) {
    for (const r of gate.reasons) console.error(`[refuse] ${r}`);
    console.error(
      "Refusing to continue: mock backends are required on BOTH " +
        "endpoints. No project/document/DB writes were attempted.",
    );
    process.exit(2);
  }
  console.log(
    `mock backends confirmed (VO_API=${env.api}, VO_WEB=${env.web})`,
  );
}

/** Fetch a complete state snapshot for non-mutation comparisons. An
 *  HTTP error, malformed JSON, foreign project, or omitted persistence
 *  collection is an inspection failure, never an empty baseline. */
export async function fetchProjectState(api, projectId) {
  const res = await fetch(`${api}/api/projects/${projectId}/state`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`state HTTP ${res.status} for project ${projectId}`);
  let state;
  try {
    state = await res.json();
  } catch {
    throw new Error(`state response for project ${projectId} is not valid JSON`);
  }
  if (
    !state || typeof state !== "object" || Array.isArray(state) ||
    state.project?.id !== projectId ||
    !Array.isArray(state.documents) ||
    !Array.isArray(state.generations) ||
    !Array.isArray(state.amendment_outcomes) ||
    state.documents.some((d) => !d || typeof d.id !== "string" || !Array.isArray(d.revisions))
  ) {
    throw new Error(`state response for project ${projectId} has an invalid shape or project mismatch`);
  }
  return state;
}

// ------------------------------------------------------- scratch DB guard

/** Verify that `dbPath` is an EXISTING database inside an explicitly
 *  designated scratch directory — never the production data dir, never
 *  created on the fly. Reuses checkScratchDataDir for the directory
 *  side and resolves the file's real path for aliases/junctions. */
export function checkScratchDbFile(dbPath, prodDataDir = join(REPO_ROOT, "data")) {
  if (!dbPath) {
    return { ok: false, reason: "no DB path given" };
  }
  const dir = dirname(resolve(dbPath));
  const dirCheck = checkScratchDataDir(dir, prodDataDir);
  if (!dirCheck.ok) {
    return { ok: false, reason: dirCheck.reason };
  }
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    return {
      ok: false,
      reason:
        `DB file does not exist: ${dbPath} — refusing to create a new ` +
        `empty DB here (it would not contain the fixture rows)`,
    };
  }
  // Resolve the file's real path — a junction inside an accepted
  // scratch dir must not be able to point at the production DB file.
  const realDb = realpathSync.native(dbPath);
  const prodDb = join(prodDataDir, "app.db");
  try {
    const realProdDb = realpathSync.native(prodDb);
    if (realDb === realProdDb) {
      return {
        ok: false,
        reason:
          `resolved DB path is the normal data location (${realProdDb}) ` +
          `— refused`,
      };
    }
  } catch {
    /* production app.db does not exist — still refuse on name match */
    if (realDb === resolve(prodDb)) {
      return { ok: false, reason: "resolved DB path is the normal data location" };
    }
  }
  return { ok: true, dbPath: realDb };
}

/** Read-only cross-check: the entities THIS seed run just created via
 *  the API must exist in the DB we are about to open for the zeta
 *  write. A mismatch means VO_SCRATCH_DB points at a different
 *  database than the test server — refuse before any write. */
export function verifyEntitiesInDb(dbPath, ids) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const missing = [];
    const check = (table, col, id) => {
      const row = db
        .prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?`)
        .get(id);
      if (!row) missing.push(`${table}.${col}=${id}`);
    };
    for (const id of ids.projects) check("projects", "id", id);
    for (const id of ids.documents) check("production_documents", "id", id);
    for (const id of ids.revisions) check("document_revisions", "id", id);
    for (const id of ids.blueprintVersions)
      check("blueprint_versions", "id", id);
    for (const id of ids.characters) check("characters", "id", id);
    return { ok: missing.length === 0, missing };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- manifest

export function saveManifest(manifest, path = defaultManifestPath()) {
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

export function loadManifest(path = defaultManifestPath()) {
  if (!existsSync(path)) {
    throw new Error(
      `manifest not found: ${path} — run seed.mjs first ` +
        `(VO_MANIFEST to override the location)`,
    );
  }
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (
    !m || typeof m !== "object" || Array.isArray(m) ||
    typeof m.run_id !== "string" || !m.run_id.trim() ||
    !m.projects || typeof m.projects !== "object" || Array.isArray(m.projects)
  ) {
    throw new Error(`manifest at ${path} is malformed`);
  }
  for (const key of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
    const p = m.projects[key];
    if (
      !p || typeof p !== "object" ||
      typeof p.name !== "string" || !p.name.trim() ||
      typeof p.project_id !== "string" || !p.project_id.trim()
    ) {
      throw new Error(`manifest at ${path} has an invalid required project "${key}"`);
    }
  }
  const zeta = m.projects.zeta;
  if (!zeta || typeof zeta !== "object" || Array.isArray(zeta)) {
    throw new Error(`manifest at ${path} is missing required projects.zeta`);
  }
  if (typeof zeta.created !== "boolean") {
    throw new Error(`manifest at ${path} has invalid projects.zeta.created`);
  }
  if (zeta.created === false) {
    if (typeof zeta.reason !== "string" || !zeta.reason.trim()) {
      throw new Error(`manifest at ${path} must give a non-empty reason when zeta.created is false`);
    }
  } else if (
    typeof zeta.name !== "string" || !zeta.name.trim() ||
    typeof zeta.project_id !== "string" || !zeta.project_id.trim() ||
    typeof zeta.blueprint_version_id !== "string" || !zeta.blueprint_version_id.trim() ||
    !zeta.docs || typeof zeta.docs !== "object" || Array.isArray(zeta.docs) ||
    !Object.values(zeta.docs).some((d) =>
      d && typeof d.document_id === "string" && d.document_id.trim() &&
      typeof d.revision_id === "string" && d.revision_id.trim()
    )
  ) {
    throw new Error(`manifest at ${path} has incomplete targets for created zeta`);
  }
  return m;
}

// ------------------------------------------------------- non-mutation diff

const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;

/** Canonical snapshot of everything a read-only preview must never
 *  change: every document (id, adopted_revision_id, state_version, and
 *  ALL revisions with content + provenance refs), every generation
 *  record, every amendment outcome. */
export function stateFingerprint(state) {
  const byId = (records) => records.slice().sort((a, b) => a.id.localeCompare(b.id));
  return stable({
    documents: byId(state.documents).map((d) => ({
      id: d.id,
      adopted_revision_id: d.adopted_revision_id,
      state_version: d.state_version,
      revisions: (d.revisions ?? []).map((r) => ({
        id: r.id,
        rev_no: r.rev_no,
        content: r.content,
        proposal_status: r.proposal_status,
        blueprint_version_id: r.blueprint_version_id,
        base_revision_id: r.base_revision_id,
        instruction_message_id: r.instruction_message_id,
      })),
      // pending_proposals is a derived display projection of revisions;
      // the persisted revision records above are the source of truth.
    })),
    // Compare persisted generation_records columns. `asset_ids` is not
    // a persisted output reference and must not stand in for these fields.
    generations: byId(state.generations).map((g) => ({
      id: g.id,
      project_id: g.project_id,
      kind: g.kind,
      status: g.status,
      blueprint_version_id: g.blueprint_version_id,
      document_revision_id: g.document_revision_id,
      inputs: g.inputs,
      backend: g.backend,
      backend_job_id: g.backend_job_id,
      output_asset_id: g.output_asset_id,
      error: g.error,
      created_at: g.created_at,
      updated_at: g.updated_at,
    })),
    // Save-time result, target, provenance, and refusal reason are all
    // persisted. UI labels and other derived views are intentionally omitted.
    amendment_outcomes: byId(state.amendment_outcomes).map((o) => ({
      id: o.id,
      project_id: o.project_id,
      instruction_message_id: o.instruction_message_id,
      assistant_message_id: o.assistant_message_id,
      document_id: o.document_id,
      base_revision_id: o.base_revision_id,
      blueprint_version_id: o.blueprint_version_id,
      outcome: o.outcome,
      result_revision_id: o.result_revision_id,
      reject_reason: o.reject_reason,
      created_at: o.created_at,
    })),
  });
}

/** Compare two fingerprints; returns [] or human-readable diffs. */
export function diffState(before, after) {
  const diffs = [];
  const bDocs = new Map(before.documents.map((d) => [d.id, d]));
  const aDocs = new Map(after.documents.map((d) => [d.id, d]));
  for (const id of aDocs.keys()) {
    if (!bDocs.has(id)) diffs.push(`document added: ${id}`);
  }
  for (const [id, b] of bDocs) {
    const a = aDocs.get(id);
    if (!a) {
      diffs.push(`document removed: ${id}`);
      continue;
    }
    if (a.adopted_revision_id !== b.adopted_revision_id)
      diffs.push(
        `document ${id}: adopted_revision_id ` +
          `${b.adopted_revision_id} -> ${a.adopted_revision_id}`,
      );
    if (a.state_version !== b.state_version)
      diffs.push(
        `document ${id}: state_version ${b.state_version} -> ${a.state_version}`,
      );
    const bRevs = new Map(b.revisions.map((r) => [r.id, r]));
    for (const r of a.revisions) {
      const old = bRevs.get(r.id);
      if (!old) {
        diffs.push(`document ${id}: revision added ${r.id}`);
      } else if (
        r.content !== old.content ||
        r.proposal_status !== old.proposal_status ||
        r.blueprint_version_id !== old.blueprint_version_id ||
        r.base_revision_id !== old.base_revision_id ||
        r.instruction_message_id !== old.instruction_message_id
      ) {
        diffs.push(`document ${id}: revision changed ${r.id}`);
      }
    }
    for (const id2 of bRevs.keys()) {
      if (!a.revisions.some((r) => r.id === id2))
        diffs.push(`document ${id}: revision removed ${id2}`);
    }
  }
  const compareRecords = (label, bRows, aRows) => {
    const bById = new Map(bRows.map((r) => [r.id, r]));
    const aById = new Map(aRows.map((r) => [r.id, r]));
    for (const id of aById.keys()) {
      if (!bById.has(id)) diffs.push(`${label} added: ${id}`);
      else if (JSON.stringify(aById.get(id)) !== JSON.stringify(bById.get(id)))
        diffs.push(`${label} changed: ${id}`);
    }
    for (const id of bById.keys()) {
      if (!aById.has(id)) diffs.push(`${label} removed: ${id}`);
    }
  };
  compareRecords("generation", before.generations, after.generations);
  compareRecords("amendment outcome", before.amendment_outcomes, after.amendment_outcomes);
  return diffs;
}
