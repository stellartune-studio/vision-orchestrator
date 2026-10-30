import { DatabaseSync } from "node:sqlite";
import type {
  GenerationStatus,
  Project,
  ProjectListItem,
  ProjectSummary,
} from "@vo/shared";
import { transact } from "../db/connection.ts";
import { newId } from "../domain/ids.ts";
import { COMMON_SEED, TEMPLATES } from "../domain/templates.ts";
import { NotFoundError } from "./errors.ts";
import { insertItem } from "./items.ts";

const projectCols =
  "id, name, purpose_note, template_key, template_version, archived_at, created_at, updated_at";

export function listProjects(
  db: DatabaseSync,
  archived: "exclude" | "only" | "all" = "exclude",
): Project[] {
  const where =
    archived === "only"
      ? "WHERE archived_at IS NOT NULL"
      : archived === "exclude"
        ? "WHERE archived_at IS NULL"
        : "";
  return db
    .prepare(
      `SELECT ${projectCols} FROM projects ${where} ORDER BY updated_at DESC`,
    )
    .all() as unknown as Project[];
}

/** Reversible archive toggle — never deletes content. */
export function setProjectArchived(
  db: DatabaseSync,
  projectId: string,
  archived: boolean,
): Project {
  const r = db
    .prepare(
      `UPDATE projects SET archived_at = CASE WHEN ? THEN datetime('now') ELSE NULL END
        WHERE id = ?`,
    )
    .run(archived ? 1 : 0, projectId);
  if (!r.changes) throw new NotFoundError(`project ${projectId}`);
  return getProject(db, projectId);
}

const emptySummary = (): ProjectSummary => ({
  adopted_items: 0,
  pending_proposals: 0,
  latest_version_no: null,
  latest_generation: null,
  latest_output_asset_id: null,
  latest_output_kind: null,
});

/**
 * Compact per-project status for the list screen. Aggregated in SQL —
 * the same source columns the detail views read, without hydrating
 * full per-project state.
 */
export function summarizeProjects(
  db: DatabaseSync,
): Map<string, ProjectSummary> {
  const out = new Map<string, ProjectSummary>();
  const ensure = (projectId: string): ProjectSummary => {
    let s = out.get(projectId);
    if (!s) {
      s = emptySummary();
      out.set(projectId, s);
    }
    return s;
  };
  for (const r of db
    .prepare(
      `SELECT project_id, COUNT(*) AS n FROM design_items
        WHERE adopted_revision_id IS NOT NULL GROUP BY project_id`,
    )
    .all() as unknown as { project_id: string; n: number }[]) {
    ensure(r.project_id).adopted_items = r.n;
  }
  for (const r of db
    .prepare(
      `SELECT i.project_id, COUNT(*) AS n
         FROM item_revisions ir JOIN design_items i ON i.id = ir.item_id
        WHERE ir.proposal_status = 'pending' GROUP BY i.project_id`,
    )
    .all() as unknown as { project_id: string; n: number }[]) {
    ensure(r.project_id).pending_proposals += r.n;
  }
  for (const r of db
    .prepare(
      `SELECT d.project_id, COUNT(*) AS n
         FROM document_revisions dr
         JOIN production_documents d ON d.id = dr.document_id
        WHERE dr.proposal_status = 'pending' GROUP BY d.project_id`,
    )
    .all() as unknown as { project_id: string; n: number }[]) {
    ensure(r.project_id).pending_proposals += r.n;
  }
  for (const r of db
    .prepare(
      `SELECT project_id, MAX(version_no) AS v
         FROM blueprint_versions GROUP BY project_id`,
    )
    .all() as unknown as { project_id: string; v: number }[]) {
    ensure(r.project_id).latest_version_no = r.v;
  }
  for (const r of db
    .prepare(
      `SELECT project_id, status FROM generation_records
        WHERE rowid IN (
          SELECT MAX(rowid) FROM generation_records GROUP BY project_id
        )`,
    )
    .all() as unknown as {
    project_id: string;
    status: GenerationStatus;
  }[]) {
    ensure(r.project_id).latest_generation = r.status;
  }
  // Latest SUCCEEDED output per project — the home list's thumbnail.
  // Read-only; a failed newest generation never hides the last good
  // result.
  for (const r of db
    .prepare(
      `SELECT project_id, output_asset_id, kind FROM generation_records
        WHERE status = 'succeeded' AND output_asset_id IS NOT NULL
          AND rowid IN (
            SELECT MAX(rowid) FROM generation_records
            WHERE status = 'succeeded' AND output_asset_id IS NOT NULL
            GROUP BY project_id
          )`,
    )
    .all() as unknown as {
    project_id: string;
    output_asset_id: string;
    kind: "image" | "video";
  }[]) {
    ensure(r.project_id).latest_output_asset_id = r.output_asset_id;
    ensure(r.project_id).latest_output_kind = r.kind;
  }
  return out;
}

/** Projects with their list summaries attached. */
export function listProjectSummaries(
  db: DatabaseSync,
  archived: "exclude" | "only" | "all" = "exclude",
): ProjectListItem[] {
  const summaries = summarizeProjects(db);
  return listProjects(db, archived).map((p) => ({
    ...p,
    summary: summaries.get(p.id) ?? emptySummary(),
  }));
}

export function getProject(db: DatabaseSync, id: string): Project {
  const row = db
    .prepare(`SELECT ${projectCols} FROM projects WHERE id = ?`)
    .get(id) as unknown as Project | undefined;
  if (!row) throw new NotFoundError(`project ${id}`);
  return row;
}

/** Create project + common undecided seed items (one transaction). */
export function createProject(
  db: DatabaseSync,
  name: string,
  purposeNote?: string,
): Project {
  const id = newId();
  db.prepare(
    "INSERT INTO projects (id, name, purpose_note) VALUES (?, ?, ?)",
  ).run(id, name, purposeNote ?? null);
  for (const [i, seed] of COMMON_SEED.entries()) {
    insertItem(db, {
      project_id: id,
      kind: seed.kind,
      label: seed.label,
      seq: seed.seq ?? i,
    });
  }
  return getProject(db, id);
}

/**
 * Apply a purpose template: insert its items that are not already
 * present (matched by kind+label) and record the template on the
 * project. Existing items are never modified. No-op when key is null.
 */
export function applyTemplate(
  db: DatabaseSync,
  projectId: string,
  templateKey: string,
): void {
  const template = TEMPLATES[templateKey];
  if (!template) return;
  const existing = db
    .prepare("SELECT kind, label FROM design_items WHERE project_id = ?")
    .all(projectId) as unknown as { kind: string; label: string }[];
  const have = new Set(existing.map((r) => `${r.kind}:${r.label}`));
  for (const seed of template.items) {
    if (have.has(`${seed.kind}:${seed.label}`)) continue;
    insertItem(db, {
      project_id: projectId,
      kind: seed.kind,
      label: seed.label,
      seq: seed.seq ?? 0,
    });
  }
  db.prepare(
    "UPDATE projects SET template_key = ?, template_version = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(template.key, template.version, projectId);
}

/**
 * Trigger names guarding the append-only invariants. A hard delete must
 * suspend them; their DDL is read from sqlite_master and restored
 * verbatim inside the same transaction — any failure rolls schema and
 * data back together, so the invariants can never be left half-disabled.
 */
const APPEND_ONLY_TRIGGERS = [
  "item_revisions_no_delete",
  "document_revisions_no_delete",
  "character_revisions_no_delete",
  "bv_items_no_delete",
  "bv_characters_no_delete",
  "bv_assets_no_delete",
  "blueprint_versions_no_delete",
] as const;

/**
 * Permanently delete a project and every project-owned row beneath it.
 * Deliberate administrative escape hatch — the append-only triggers are
 * suspended and restored inside one transaction. Shared-library
 * characters and character-owned assets survive; only assets owned by
 * the project are removed. Project asset file paths are returned so the
 * caller can unlink them AFTER commit (file I/O never inside the tx).
 */
export function deleteProject(
  db: DatabaseSync,
  projectId: string,
): { asset_paths: string[] } {
  getProject(db, projectId);
  return transact(db, () => {
    const triggerSql: string[] = [];
    for (const name of APPEND_ONLY_TRIGGERS) {
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        )
        .get(name) as { sql: string } | undefined;
      if (!row?.sql) {
        throw new Error(`append-only trigger missing: ${name}`);
      }
      triggerSql.push(row.sql);
      db.exec(`DROP TRIGGER ${name}`);
    }
    try {
      // Break the circular adopted-revision FKs before deleting revisions.
      db.prepare(
        "UPDATE production_documents SET adopted_revision_id = NULL WHERE project_id = ?",
      ).run(projectId);
      db.prepare(
        "UPDATE design_items SET adopted_revision_id = NULL WHERE project_id = ?",
      ).run(projectId);
      // Leaf rows first; approval_events go after the pointer clears
      // because the adoption audit triggers append during those UPDATEs.
      for (const sql of [
        "DELETE FROM amendment_outcomes WHERE project_id = ?",
        // approval_events / item_revisions carry no project_id —
        // they join through the entity they audit or the item row.
        "DELETE FROM approval_events WHERE (entity_kind = 'design_item' AND entity_id IN (SELECT id FROM design_items WHERE project_id = ?)) OR (entity_kind = 'production_document' AND entity_id IN (SELECT id FROM production_documents WHERE project_id = ?))",
        "DELETE FROM scene_input_draft_reviews WHERE project_id = ?",
        "DELETE FROM scene_input_drafts WHERE project_id = ?",
        "DELETE FROM blueprint_version_items WHERE project_id = ?",
        "DELETE FROM blueprint_version_characters WHERE project_id = ?",
        "DELETE FROM blueprint_version_assets WHERE project_id = ?",
        "DELETE FROM project_characters WHERE project_id = ?",
        "DELETE FROM project_generation_selection WHERE project_id = ?",
        "DELETE FROM project_workbench WHERE project_id = ?",
        "DELETE FROM generation_records WHERE project_id = ?",
        "DELETE FROM document_revisions WHERE project_id = ?",
        "DELETE FROM production_documents WHERE project_id = ?",
        "DELETE FROM item_revisions WHERE item_id IN (SELECT id FROM design_items WHERE project_id = ?)",
        "DELETE FROM design_items WHERE project_id = ?",
        "DELETE FROM messages WHERE project_id = ?",
        "DELETE FROM blueprint_versions WHERE project_id = ?",
      ]) {
        db.prepare(sql).run(projectId);
      }
      const assetPaths = (
        db
          .prepare(
            "SELECT path FROM assets WHERE owner_kind = 'project' AND owner_id = ?",
          )
          .all(projectId) as { path: string }[]
      ).map((r) => r.path);
      db.prepare(
        "DELETE FROM assets WHERE owner_kind = 'project' AND owner_id = ?",
      ).run(projectId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      return { asset_paths: assetPaths };
    } finally {
      for (const sql of triggerSql) db.exec(sql);
    }
  });
}
