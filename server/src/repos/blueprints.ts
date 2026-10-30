import { DatabaseSync } from "node:sqlite";
import type {
  BlueprintVersion,
  BlueprintVersionAsset,
  BlueprintVersionCharacter,
  BlueprintVersionDetail,
  BlueprintVersionItem,
} from "@vo/shared";
import { newId } from "../domain/ids.ts";
import { NotFoundError } from "./errors.ts";
import { assertSceneCharacterPins, sceneCharacters } from "./sceneCharacters.ts";
import { assertAnimationPins } from "./animationCast.ts";

const bvCols =
  "id, project_id, version_no, note, template_key, template_version, created_at";

/**
 * Freeze the current blueprint into an immutable version: adopted item
 * revisions + ordering + segment/shot links + pinned character
 * revisions (+ base images) + selected assets + template identity.
 * Later edits can never rewrite a finalized snapshot.
 */
export function createBlueprintVersion(
  db: DatabaseSync,
  projectId: string,
  note?: string,
): BlueprintVersion {
  assertSceneCharacterPins(db, projectId);
  assertAnimationPins(db, projectId);
  const id = newId();
  const project = db
    .prepare("SELECT template_key, template_version FROM projects WHERE id = ?")
    .get(projectId) as
    | { template_key: string | null; template_version: number | null }
    | undefined;
  if (!project) throw new NotFoundError(`project ${projectId}`);

  const versionNo =
    (db
      .prepare(
        "SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM blueprint_versions WHERE project_id = ?",
      )
      .get(projectId) as { n: number }).n;

  db.prepare(
    `INSERT INTO blueprint_versions
       (id, project_id, version_no, note, template_key, template_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, versionNo, note ?? null, project.template_key, project.template_version);

  db.prepare(
    `INSERT INTO blueprint_version_items
       (blueprint_version_id, project_id, item_id, revision_id, seq,
        parent_item_id, kind, label)
     SELECT ?, project_id, id, adopted_revision_id, seq,
            parent_item_id, kind, label
       FROM design_items
      WHERE project_id = ? AND adopted_revision_id IS NOT NULL`,
  ).run(id, projectId);

  db.prepare(
    `INSERT INTO blueprint_version_characters
       (blueprint_version_id, project_id, character_id,
        character_revision_id, base_image_asset_id)
     SELECT ?, pc.project_id, pc.character_id, pc.character_revision_id,
            cr.base_image_asset_id
       FROM project_characters pc
       JOIN character_revisions cr
         ON cr.id = pc.character_revision_id
        AND cr.character_id = pc.character_id
      WHERE pc.project_id = ?`,
  ).run(id, projectId);

  db.prepare(
    `INSERT INTO blueprint_version_assets
       (blueprint_version_id, project_id, asset_id, role)
     SELECT ?, ?, id, 'material'
       FROM assets
      WHERE owner_kind = 'project' AND owner_id = ? AND selected = 1`,
  ).run(id, projectId, projectId);

  return getBlueprintVersion(db, id);
}

export function getBlueprintVersion(
  db: DatabaseSync,
  id: string,
): BlueprintVersion {
  const row = db
    .prepare(`SELECT ${bvCols} FROM blueprint_versions WHERE id = ?`)
    .get(id) as unknown as BlueprintVersion | undefined;
  if (!row) throw new NotFoundError(`blueprint version ${id}`);
  return row;
}

export function getBlueprintVersionDetail(
  db: DatabaseSync,
  id: string,
): BlueprintVersionDetail {
  const bv = getBlueprintVersion(db, id);
  const items = db
    .prepare(
      `SELECT blueprint_version_id, item_id, revision_id, seq,
              parent_item_id, kind, label
         FROM blueprint_version_items
        WHERE blueprint_version_id = ? ORDER BY kind, seq`,
    )
    .all(id) as unknown as BlueprintVersionItem[];
  const characters = db
    .prepare(
      `SELECT blueprint_version_id, character_id, character_revision_id,
              base_image_asset_id
         FROM blueprint_version_characters
        WHERE blueprint_version_id = ?`,
    )
    .all(id) as unknown as BlueprintVersionCharacter[];
  const assets = db
    .prepare(
      `SELECT blueprint_version_id, asset_id, role
         FROM blueprint_version_assets WHERE blueprint_version_id = ?`,
    )
    .all(id) as unknown as BlueprintVersionAsset[];
  return { ...bv, items, characters, assets };
}

export interface FrozenBlueprintContext {
  version_no: number;
  items: { kind: string; label: string; content: string }[];
  fixed_constraints: { label: string; content: string }[];
  characters: {
    name: string;
    locked_traits: Record<string, string>;
    has_base_image: boolean;
  }[];
}

/**
 * The production standards frozen in a blueprint version, resolved to
 * content: adopted item bodies, fixed constraints, and the pinned
 * character revisions' locked traits. This is what a document revision
 * deriving from the version was drafted against — live project state
 * is a different axis and never mixes in here.
 */
export function blueprintFrozenContext(
  db: DatabaseSync,
  blueprintVersionId: string,
): FrozenBlueprintContext {
  const detail = getBlueprintVersionDetail(db, blueprintVersionId);
  const items = detail.items.map((i) => {
    const rev = db
      .prepare(`SELECT content FROM item_revisions WHERE id = ?`)
      .get(i.revision_id) as { content: string } | undefined;
    const cast = i.kind === "story_segment" ? sceneCharacters(db, i.revision_id) : [];
    const content = rev?.content ?? "";
    return { kind: i.kind, label: i.label, content: cast.length ? `${content}\nCharacters in scene: ${cast.map((c) => c.name).join(", ")}` : content };
  });
  const characters = detail.characters.map((c) => {
    const row = db
      .prepare(
        `SELECT ch.name, cr.profile, cr.base_image_asset_id
           FROM blueprint_version_characters bvc
           JOIN characters ch ON ch.id = bvc.character_id
           JOIN character_revisions cr ON cr.id = bvc.character_revision_id
          WHERE bvc.blueprint_version_id = ? AND bvc.character_id = ?`,
      )
      .get(blueprintVersionId, c.character_id) as
      | { name: string; profile: string; base_image_asset_id: string | null }
      | undefined;
    let locked: Record<string, string> = {};
    try {
      locked =
        (JSON.parse(row?.profile ?? "{}") as {
          traits?: { locked?: Record<string, string> };
        }).traits?.locked ?? {};
    } catch {
      locked = {};
    }
    return {
      name: row?.name ?? c.character_id,
      locked_traits: locked,
      has_base_image: c.base_image_asset_id != null,
    };
  });
  return {
    version_no: detail.version_no,
    items,
    fixed_constraints: items
      .filter((i) => i.kind === "fixed_constraint")
      .map((i) => ({ label: i.label, content: i.content })),
    characters,
  };
}

/**
 * Human-readable lines describing how the project's LIVE blueprint
 * state diverges from a frozen version — same dimensions as the
 * signature comparison (item revisions/order/links, character pins,
 * asset selection), surfaced so a model can be told "this is not the
 * basis". Empty array = in sync.
 */
export function blueprintDriftNotes(
  db: DatabaseSync,
  blueprintVersionId: string,
): string[] {
  const detail = getBlueprintVersionDetail(db, blueprintVersionId);
  const notes: string[] = [];

  const liveItems = db
    .prepare(
      `SELECT id, label, adopted_revision_id, seq, parent_item_id
         FROM design_items WHERE project_id = ?`,
    )
    .all(detail.project_id) as unknown as {
    id: string;
    label: string;
    adopted_revision_id: string | null;
    seq: number;
    parent_item_id: string | null;
  }[];
  const liveById = new Map(liveItems.map((i) => [i.id, i]));
  const snapItemIds = new Set(detail.items.map((i) => i.item_id));
  for (const i of detail.items) {
    const live = liveById.get(i.item_id);
    if (!live || !live.adopted_revision_id) {
      notes.push(`Item "${i.label}" currently has no adopted content`);
    } else if (live.adopted_revision_id !== i.revision_id) {
      notes.push(`Item "${i.label}" changed its adopted revision after the freeze`);
    } else if (
      live.seq !== i.seq ||
      (live.parent_item_id ?? null) !== (i.parent_item_id ?? null)
    ) {
      notes.push(`Item "${i.label}" changed order or parent link`);
    }
  }
  for (const li of liveItems) {
    if (li.adopted_revision_id && !snapItemIds.has(li.id)) {
      notes.push(`Item "${li.label}" was adopted after the freeze`);
    }
  }

  const livePins = new Map(
    (
      db
        .prepare(
          `SELECT pc.character_id, pc.character_revision_id, c.name
             FROM project_characters pc
             JOIN characters c ON c.id = pc.character_id
            WHERE pc.project_id = ?`,
        )
        .all(detail.project_id) as unknown as {
        character_id: string;
        character_revision_id: string;
        name: string;
      }[]
    ).map((p) => [p.character_id, p]),
  );
  const snapCharIds = new Set(detail.characters.map((c) => c.character_id));
  for (const c of detail.characters) {
    const live = livePins.get(c.character_id);
    const name =
      live?.name ??
      (
        db
          .prepare(`SELECT name FROM characters WHERE id = ?`)
          .get(c.character_id) as { name: string } | undefined
      )?.name ??
      c.character_id;
    if (!live) {
      notes.push(`Character "${name}" was unpinned after the freeze`);
    } else if (live.character_revision_id !== c.character_revision_id) {
      notes.push(`Character "${name}" changed its pinned revision after the freeze`);
    }
  }
  for (const [id, p] of livePins) {
    if (!snapCharIds.has(id)) {
      notes.push(`Character "${p.name}" was pinned after the freeze`);
    }
  }

  const liveAssets = new Set(
    (
      db
        .prepare(
          `SELECT id FROM assets
            WHERE owner_kind = 'project' AND owner_id = ? AND selected = 1`,
        )
        .all(detail.project_id) as { id: string }[]
    ).map((a) => a.id),
  );
  const snapAssets = new Set(detail.assets.map((a) => a.asset_id));
  let assetDiffs = 0;
  for (const a of snapAssets) if (!liveAssets.has(a)) assetDiffs++;
  for (const a of liveAssets) if (!snapAssets.has(a)) assetDiffs++;
  if (assetDiffs > 0) {
    notes.push(`Asset selection changed by ${assetDiffs} entries after the freeze`);
  }
  return notes;
}

export function listBlueprintVersions(
  db: DatabaseSync,
  projectId: string,
): BlueprintVersion[] {
  return db
    .prepare(
      `SELECT ${bvCols} FROM blueprint_versions
        WHERE project_id = ? ORDER BY version_no`,
    )
    .all(projectId) as unknown as BlueprintVersion[];
}

interface SignatureRows {
  items: {
    item_id: string;
    revision_id: string;
    seq: number;
    parent_item_id: string | null;
  }[];
  characters: { character_id: string; character_revision_id: string }[];
  assets: { asset_id: string; role: string }[];
}

/** Canonical string form — same rows in, same signature out. */
function serializeSignature(r: SignatureRows): string {
  const i = r.items
    .map(
      (x) =>
        `${x.item_id}=${x.revision_id}#${x.seq}#${x.parent_item_id ?? "-"}`,
    )
    .join(",");
  const c = r.characters
    .map((x) => `${x.character_id}=${x.character_revision_id}`)
    .join(",");
  const a = r.assets.map((x) => `${x.asset_id}:${x.role}`).join(",");
  return `i[${i}]c[${c}]a[${a}]`;
}

/**
 * Fingerprint of everything a blueprint version froze — adopted item
 * revisions WITH their order/parent links, pinned character revisions,
 * and selected materials — for recheck diffing. Comparing only the
 * revision id set would miss a character re-pin, an asset (de)select,
 * or a reorder whose text stayed identical.
 */
export function snapshotSignature(
  db: DatabaseSync,
  blueprintVersionId: string,
): string {
  const items = db
    .prepare(
      `SELECT item_id, revision_id, seq, parent_item_id
         FROM blueprint_version_items
        WHERE blueprint_version_id = ? ORDER BY item_id`,
    )
    .all(blueprintVersionId) as unknown as SignatureRows["items"];
  const characters = db
    .prepare(
      `SELECT character_id, character_revision_id
         FROM blueprint_version_characters
        WHERE blueprint_version_id = ? ORDER BY character_id`,
    )
    .all(blueprintVersionId) as unknown as SignatureRows["characters"];
  const assets = db
    .prepare(
      `SELECT asset_id, role FROM blueprint_version_assets
        WHERE blueprint_version_id = ? ORDER BY asset_id`,
    )
    .all(blueprintVersionId) as unknown as SignatureRows["assets"];
  return serializeSignature({ items, characters, assets });
}

/** The same fingerprint over the project's CURRENT blueprint state. */
export function currentSignature(
  db: DatabaseSync,
  projectId: string,
): string {
  const items = db
    .prepare(
      `SELECT id AS item_id, adopted_revision_id AS revision_id,
              seq, parent_item_id
         FROM design_items
        WHERE project_id = ? AND adopted_revision_id IS NOT NULL
        ORDER BY id`,
    )
    .all(projectId) as unknown as SignatureRows["items"];
  const characters = db
    .prepare(
      `SELECT character_id, character_revision_id
         FROM project_characters WHERE project_id = ?
        ORDER BY character_id`,
    )
    .all(projectId) as unknown as SignatureRows["characters"];
  const assets = db
    .prepare(
      `SELECT id AS asset_id, 'material' AS role FROM assets
        WHERE owner_kind = 'project' AND owner_id = ? AND selected = 1
        ORDER BY id`,
    )
    .all(projectId) as unknown as SignatureRows["assets"];
  return serializeSignature({ items, characters, assets });
}
