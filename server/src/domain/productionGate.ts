import type { DatabaseSync } from "node:sqlite";
import { TEMPLATES } from "./templates.ts";
import { getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { listApprovedDocumentRevisionIdsForBlueprint } from "../repos/documents.ts";
import { getProject } from "../repos/projects.ts";

/**
 * Production gate: server-side conditions for media generation.
 *   - the blueprint version exists in this project
 *   - every required item kind of the project's template has adopted
 *     content inside the snapshot
 *   - at least one document has an adopted revision drafted from THIS
 *     blueprint version (script/storyboard approval precedes production)
 *
 * Returns ALL approved document revision ids derived from the version —
 * the caller resolves the single usable one, never a silent LIMIT 1.
 */
export function checkProductionGate(
  db: DatabaseSync,
  projectId: string,
  blueprintVersionId: string,
): { ok: boolean; missing: string[]; document_revision_ids: string[] } {
  const missing: string[] = [];
  const bv = getBlueprintVersionDetail(db, blueprintVersionId);
  if (bv.project_id !== projectId) {
    return {
      ok: false,
      missing: ["blueprint version belongs to another project"],
      document_revision_ids: [],
    };
  }
  const project = getProject(db, projectId);
  const template = project.template_key
    ? TEMPLATES[project.template_key]
    : undefined;
  const required = template?.required_kinds ?? ["intent", "output_policy"];
  const snapshotKinds = new Set(bv.items.map((i) => i.kind));
  for (const kind of required) {
    if (!snapshotKinds.has(kind)) {
      missing.push(`no adopted "${kind}" item in blueprint v${bv.version_no}`);
    }
  }
  const documentRevisionIds = listApprovedDocumentRevisionIdsForBlueprint(
    db,
    projectId,
    blueprintVersionId,
  );
  if (documentRevisionIds.length === 0) {
    missing.push(
      `no approved document revision derived from blueprint v${bv.version_no}`,
    );
  }
  return {
    ok: missing.length === 0,
    missing,
    document_revision_ids: documentRevisionIds,
  };
}
