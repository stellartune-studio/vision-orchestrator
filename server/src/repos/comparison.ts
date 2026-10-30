import { realpathSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ComparisonSelection } from "@vo/shared";
import { isUnder } from "../util/paths.ts";
import { findAsset } from "./assets.ts";
import { getBlueprintVersionDetail } from "./blueprints.ts";
import { getGeneration } from "./generations.ts";
import { getProject } from "./projects.ts";
import { BadRequestError, ConflictError } from "./errors.ts";

function validRecord(db: DatabaseSync, projectId: string, id: string, root: string): boolean {
  try {
    const record = getGeneration(db, id);
    if (record.project_id !== projectId || (record.blueprint_version_id && getBlueprintVersionDetail(db, record.blueprint_version_id).project_id !== projectId)) return false;
    if (!record.output_asset_id) return record.status !== "succeeded";
    const asset = findAsset(db, record.output_asset_id);
    return !!asset && asset.owner_kind === "project" && asset.owner_id === projectId &&
      isUnder(realpathSync(root), realpathSync(asset.path)) && statSync(asset.path).isFile();
  } catch { return false; }
}
function row(db: DatabaseSync, projectId: string): { ids_json: string; version: number } | undefined {
  return db.prepare("SELECT ids_json, version FROM project_comparison WHERE project_id = ?").get(projectId) as { ids_json: string; version: number } | undefined;
}
export function getComparison(db: DatabaseSync, projectId: string, root: string): ComparisonSelection {
  getProject(db, projectId);
  const saved = row(db, projectId);
  if (!saved) return { ids: null, version: null, stale: false };
  let ids: unknown;
  try { ids = JSON.parse(saved.ids_json); } catch { return { ids: null, version: saved.version, stale: true }; }
  if (ids === null) return { ids: null, version: saved.version, stale: false };
  if (!Array.isArray(ids) || ids.length > 2 || ids.some((id) => typeof id !== "string" || !id || id.length > 128) || new Set(ids).size !== ids.length) return { ids: null, version: saved.version, stale: true };
  const current = ids.filter((id: string) => validRecord(db, projectId, id, root));
  return { ids: current, version: saved.version, stale: current.length !== ids.length };
}
/** Called inside a transaction; never overwrites another browser's newer selection. */
export function saveComparison(db: DatabaseSync, projectId: string, ids: unknown, expectedVersion: unknown, root: string): ComparisonSelection {
  getProject(db, projectId);
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1)) throw new BadRequestError("expected_version must be null or a positive integer");
  if (ids !== null && (!Array.isArray(ids) || ids.length > 2 || ids.some((id) => typeof id !== "string" || !id || id.length > 128) || new Set(ids).size !== ids.length)) throw new BadRequestError("Choose at most two distinct generation records");
  const previous = row(db, projectId);
  if ((previous?.version ?? null) !== expectedVersion) throw new ConflictError("Comparison changed in another browser; reload to choose again");
  if (Array.isArray(ids) && ids.some((id: string) => !validRecord(db, projectId, id, root))) throw new BadRequestError("Comparison records and output assets must belong to this project and remain available");
  if (previous) db.prepare("UPDATE project_comparison SET ids_json = ?, version = version + 1 WHERE project_id = ? AND version = ?").run(JSON.stringify(ids), projectId, previous.version);
  else db.prepare("INSERT INTO project_comparison (project_id, ids_json, version) VALUES (?, ?, 1)").run(projectId, JSON.stringify(ids));
  return getComparison(db, projectId, root);
}
