import { DatabaseSync } from "node:sqlite";
import type { Asset } from "@vo/shared";
import { newId } from "../domain/ids.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

const cols =
  "id, owner_kind, owner_id, kind, path, mime, sha256, meta, selected, selection_version, created_at";

export function findAsset(db: DatabaseSync, id: string): Asset | undefined {
  return db
    .prepare(`SELECT ${cols} FROM assets WHERE id = ?`)
    .get(id) as unknown as Asset | undefined;
}

export function getAsset(db: DatabaseSync, id: string): Asset {
  const row = findAsset(db, id);
  if (!row) throw new NotFoundError(`asset ${id}`);
  return row;
}

/**
 * Verify that a polymorphic asset owner exists. Callers that touch the
 * filesystem must run this BEFORE creating directories or files.
 */
export function requireAssetOwner(
  db: DatabaseSync,
  owner_kind: Asset["owner_kind"],
  owner_id: string,
): void {
  const owner =
    owner_kind === "project"
      ? db.prepare("SELECT id FROM projects WHERE id = ?").get(owner_id)
      : db
          .prepare("SELECT id FROM characters WHERE id = ?")
          .get(owner_id);
  if (!owner) {
    throw new BadRequestError(
      `asset owner ${owner_kind}:${owner_id} does not exist`,
    );
  }
}

/**
 * Register an asset row. owner_kind/owner_id is a polymorphic reference
 * that SQL cannot FK — the repo layer verifies the owner exists.
 */
export function insertAsset(
  db: DatabaseSync,
  input: {
    id?: string;
    owner_kind: Asset["owner_kind"];
    owner_id: string;
    kind: string;
    path: string;
    mime?: string;
    sha256?: string;
    meta?: string;
  },
): Asset {
  requireAssetOwner(db, input.owner_kind, input.owner_id);
  const id = input.id ?? newId();
  db.prepare(
    `INSERT INTO assets (id, owner_kind, owner_id, kind, path, mime, sha256, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.owner_kind,
    input.owner_id,
    input.kind,
    input.path,
    input.mime ?? null,
    input.sha256 ?? null,
    input.meta ?? null,
  );
  return getAsset(db, id);
}

export function listProjectAssets(
  db: DatabaseSync,
  projectId: string,
): Asset[] {
  return db
    .prepare(
      `SELECT ${cols} FROM assets
        WHERE owner_kind = 'project' AND owner_id = ?
        ORDER BY created_at`,
    )
    .all(projectId) as unknown as Asset[];
}

/** Mark an asset selected/deselected for blueprint snapshots. */
export function setAssetSelected(
  db: DatabaseSync,
  assetId: string,
  selected: boolean,
  expectedVersion: number,
): Asset {
  getAsset(db, assetId);
  const result = db.prepare("UPDATE assets SET selected = ?, selection_version = selection_version + 1 WHERE id = ? AND selection_version = ?").run(selected ? 1 : 0, assetId, expectedVersion);
  if (!result.changes) throw new ConflictError("Asset selection changed; fetch and compare the latest state before choosing again");
  return getAsset(db, assetId);
}
