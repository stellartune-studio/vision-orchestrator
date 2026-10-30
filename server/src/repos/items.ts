import { DatabaseSync } from "node:sqlite";
import type {
  DesignItem,
  ItemRevision,
  ItemView,
  RevisionSource,
} from "@vo/shared";
import { newId } from "../domain/ids.ts";
import {
  adoptionState,
  isStaleProposal,
  pendingProposals,
} from "../domain/state.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

const itemCols =
  "id, project_id, kind, seq, parent_item_id, label, adopted_revision_id, state_version, created_at";
const revCols =
  "id, item_id, rev_no, content, source, proposal_status, base_state_version, created_at";

export function getItem(db: DatabaseSync, id: string): DesignItem {
  const row = db
    .prepare(`SELECT ${itemCols} FROM design_items WHERE id = ?`)
    .get(id) as unknown as DesignItem | undefined;
  if (!row) throw new NotFoundError(`design item ${id}`);
  return row;
}

export function findItemRevision(
  db: DatabaseSync,
  id: string,
): ItemRevision | undefined {
  return db
    .prepare(`SELECT ${revCols} FROM item_revisions WHERE id = ?`)
    .get(id) as unknown as ItemRevision | undefined;
}

export function listItemRevisions(
  db: DatabaseSync,
  itemId: string,
): ItemRevision[] {
  return db
    .prepare(
      `SELECT ${revCols} FROM item_revisions WHERE item_id = ? ORDER BY rev_no`,
    )
    .all(itemId) as unknown as ItemRevision[];
}

export function toItemView(
  item: DesignItem,
  revisions: ItemRevision[],
): ItemView {
  const pending = pendingProposals(revisions);
  return {
    ...item,
    adoption: adoptionState(item.adopted_revision_id, revisions),
    adopted_revision:
      revisions.find((r) => r.id === item.adopted_revision_id) ?? null,
    pending_proposals: pending,
    stale_proposal_count: pending.filter((r) =>
      isStaleProposal(r, item.state_version),
    ).length,
    revisions,
  };
}

export function listItemViews(
  db: DatabaseSync,
  projectId: string,
): ItemView[] {
  const items = db
    .prepare(
      `SELECT ${itemCols} FROM design_items WHERE project_id = ? ORDER BY kind, seq, created_at`,
    )
    .all(projectId) as unknown as DesignItem[];
  return items.map((i) => toItemView(i, listItemRevisions(db, i.id)));
}

export function insertItem(
  db: DatabaseSync,
  input: {
    project_id: string;
    kind: DesignItem["kind"];
    label: string;
    seq?: number;
    parent_item_id?: string | null;
  },
): DesignItem {
  const id = newId();
  if (input.parent_item_id) {
    const parent = getItem(db, input.parent_item_id);
    if (parent.project_id !== input.project_id) {
      throw new BadRequestError("parent item belongs to another project");
    }
    if (input.kind === "shot" && parent.kind !== "story_segment") {
      throw new BadRequestError("shot parent must be a story_segment");
    }
  }
  db.prepare(
    `INSERT INTO design_items
       (id, project_id, kind, seq, parent_item_id, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.kind,
    input.seq ?? 0,
    input.parent_item_id ?? null,
    input.label,
  );
  return getItem(db, id);
}

/** Call inside a transaction so concurrent additions receive distinct order values. */
export function appendStoryScene(db: DatabaseSync, projectId: string): DesignItem {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM design_items WHERE project_id = ? AND kind = 'story_segment'").get(projectId) as { max_seq: number };
  const seq = row.max_seq + 1;
  return insertItem(db, { project_id: projectId, kind: "story_segment", label: `Scene ${seq}`, seq });
}

/** Append a shot within its parent scene while the caller holds a transaction. */
export function appendAnimationShot(db: DatabaseSync, projectId: string, parentId: string, label: string): DesignItem {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM design_items WHERE project_id = ? AND kind = 'shot' AND parent_item_id = ?").get(projectId, parentId) as { max_seq: number };
  return insertItem(db, { project_id: projectId, kind: "shot", parent_item_id: parentId, label, seq: row.max_seq + 1 });
}

/** Reorder the complete scene set under one transaction with per-item CAS. */
export function reorderStoryScenes(db: DatabaseSync, projectId: string, order: { id: string; expected_version: number }[]): DesignItem[] {
  const existing = db.prepare(`SELECT ${itemCols} FROM design_items WHERE project_id = ? AND kind = 'story_segment' ORDER BY seq, created_at, id`).all(projectId) as unknown as DesignItem[];
  if (order.length !== existing.length || new Set(order.map((entry) => entry.id)).size !== order.length) {
    throw new ConflictError("Scene set changed; reload before reordering");
  }
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const entry of order) {
    const item = byId.get(entry.id);
    if (!item || item.state_version !== entry.expected_version) throw new ConflictError("Scene changed; reload before reordering");
  }
  const update = db.prepare("UPDATE design_items SET seq = ?, state_version = state_version + 1 WHERE project_id = ? AND id = ? AND state_version = ?");
  order.forEach((entry, index) => {
    const item = byId.get(entry.id)!;
    if (item.seq === index + 1) return;
    if (update.run(index + 1, projectId, entry.id, entry.expected_version).changes !== 1) throw new ConflictError("Scene changed; reload before reordering");
  });
  return order.map((entry) => getItem(db, entry.id));
}

/** Append a new revision (proposal or user content). Never edits an
 * existing revision — a new draft is always a new version. */
export function insertRevision(
  db: DatabaseSync,
  input: {
    item_id: string;
    content: string;
    source: RevisionSource;
    base_state_version?: number;
    /** A cast proposal replaces rather than inherits the adopted cast. */
    inherit_scene_characters?: boolean;
  },
): ItemRevision {
  const item = getItem(db, input.item_id);
  const id = newId();
  db.prepare(
    `INSERT INTO item_revisions
       (id, item_id, rev_no, content, source, proposal_status, base_state_version)
     VALUES (?, ?,
       (SELECT COALESCE(MAX(rev_no), 0) + 1 FROM item_revisions WHERE item_id = ?),
       ?, ?, 'pending', ?)`,
  ).run(
    id,
    input.item_id,
    input.item_id,
    input.content,
    input.source,
    input.base_state_version ?? item.state_version,
  );
  if (item.kind === "story_segment" && item.adopted_revision_id && input.inherit_scene_characters !== false) {
    const prior = db.prepare("SELECT revision_id FROM scene_character_proposals WHERE revision_id = ?").get(item.adopted_revision_id);
    if (prior) {
      db.prepare("INSERT INTO scene_character_proposals (revision_id) VALUES (?)").run(id);
      db.prepare(`INSERT INTO scene_revision_characters (revision_id, character_id, character_revision_id, name)
        SELECT ?, character_id, character_revision_id, name FROM scene_revision_characters WHERE revision_id = ?`).run(id, item.adopted_revision_id);
    }
  }
  if (item.kind === "shot" && item.adopted_revision_id) {
    db.prepare(`INSERT INTO animation_shot_cast (revision_id, character_id, character_revision_id)
      SELECT ?, character_id, character_revision_id FROM animation_shot_cast WHERE revision_id = ?`).run(id, item.adopted_revision_id);
  }
  return db
    .prepare(`SELECT ${revCols} FROM item_revisions WHERE id = ?`)
    .get(id) as unknown as ItemRevision;
}

/**
 * Adopt a revision. Caller wraps this in a transaction. Steps:
 *   1. verify the revision belongs to the item
 *   2. optimistic-concurrency guard on state_version (409 on mismatch)
 *   3. pointer update (trigger writes the approval event)
 *   4. mark revision adopted, supersede remaining pending proposals
 */
export function adoptRevision(
  db: DatabaseSync,
  input: {
    item_id: string;
    revision_id: string;
    expected_version: number;
  },
): ItemView {
  const item = getItem(db, input.item_id);
  const rev = db
    .prepare(
      `SELECT ${revCols} FROM item_revisions WHERE id = ? AND item_id = ?`,
    )
    .get(input.revision_id, input.item_id) as unknown as
    | ItemRevision
    | undefined;
  if (!rev) {
    throw new BadRequestError("revision does not belong to this item");
  }
  const res = db
    .prepare(
      `UPDATE design_items
         SET adopted_revision_id = ?, state_version = state_version + 1
       WHERE id = ? AND state_version = ?`,
    )
    .run(input.revision_id, input.item_id, input.expected_version);
  if (res.changes === 0) {
    throw new ConflictError(
      `state_version mismatch: expected ${input.expected_version}, current ${item.state_version}`,
    );
  }
  db.prepare(
    "UPDATE item_revisions SET proposal_status = 'adopted' WHERE id = ?",
  ).run(input.revision_id);
  db.prepare(
    `UPDATE item_revisions SET proposal_status = 'superseded'
       WHERE item_id = ? AND proposal_status = 'pending'`,
  ).run(input.item_id);
  return toItemView(getItem(db, input.item_id), listItemRevisions(db, input.item_id));
}

/** User decision to reject a pending proposal. */
export function dismissRevision(
  db: DatabaseSync,
  input: {
    item_id: string;
    revision_id: string;
    expected_version: number;
  },
): ItemView {
  const item = getItem(db, input.item_id);
  const res = db
    .prepare(
      `UPDATE item_revisions SET proposal_status = 'dismissed'
       WHERE id = ? AND item_id = ? AND proposal_status = 'pending'`,
    )
    .run(input.revision_id, input.item_id);
  if (res.changes === 0) {
    throw new BadRequestError("no pending proposal with that revision id");
  }
  const bump = db
    .prepare(
      `UPDATE design_items SET state_version = state_version + 1
       WHERE id = ? AND state_version = ?`,
    )
    .run(input.item_id, input.expected_version);
  if (bump.changes === 0) {
    throw new ConflictError(
      `state_version mismatch: expected ${input.expected_version}, current ${item.state_version}`,
    );
  }
  return toItemView(getItem(db, input.item_id), listItemRevisions(db, input.item_id));
}
