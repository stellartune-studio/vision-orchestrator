import { DatabaseSync } from "node:sqlite";
import type {
  DocumentRevision,
  DocumentView,
  ProductionDocument,
  RevisionSource,
} from "@vo/shared";
import { newId } from "../domain/ids.ts";
import { adoptionState, pendingProposals } from "../domain/state.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

const docCols =
  "id, project_id, kind, title, adopted_revision_id, state_version, created_at";
const revCols =
  "id, document_id, rev_no, content, source, blueprint_version_id, base_revision_id, instruction_message_id, proposal_status, base_state_version, created_at";

export function getDocument(
  db: DatabaseSync,
  id: string,
): ProductionDocument {
  const row = db
    .prepare(`SELECT ${docCols} FROM production_documents WHERE id = ?`)
    .get(id) as unknown as ProductionDocument | undefined;
  if (!row) throw new NotFoundError(`document ${id}`);
  return row;
}

export function listDocumentRevisions(
  db: DatabaseSync,
  documentId: string,
): DocumentRevision[] {
  return db
    .prepare(
      `SELECT ${revCols} FROM document_revisions WHERE document_id = ? ORDER BY rev_no`,
    )
    .all(documentId) as unknown as DocumentRevision[];
}

export function listApprovedDocumentRevisionIdsForBlueprint(
  db: DatabaseSync,
  projectId: string,
  blueprintVersionId: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT dr.id FROM production_documents d
           JOIN document_revisions dr ON dr.id = d.adopted_revision_id
          WHERE d.project_id = ? AND dr.blueprint_version_id = ?
          ORDER BY d.created_at`,
      )
      .all(projectId, blueprintVersionId) as { id: string }[]
  ).map((row) => row.id);
}

export function findDocumentRevision(
  db: DatabaseSync,
  revisionId: string,
): DocumentRevision | undefined {
  return db
    .prepare(`SELECT ${revCols} FROM document_revisions WHERE id = ?`)
    .get(revisionId) as unknown as DocumentRevision | undefined;
}

/** A revision that must belong to the given document — 400 otherwise. */
export function getDocumentRevision(
  db: DatabaseSync,
  documentId: string,
  revisionId: string,
): DocumentRevision {
  const rev = db
    .prepare(
      `SELECT ${revCols} FROM document_revisions
        WHERE id = ? AND document_id = ?`,
    )
    .get(revisionId, documentId) as unknown as DocumentRevision | undefined;
  if (!rev) {
    throw new BadRequestError("revision does not belong to this document");
  }
  return rev;
}

export function insertDocument(
  db: DatabaseSync,
  input: {
    project_id: string;
    kind: ProductionDocument["kind"];
    title?: string;
  },
): ProductionDocument {
  const id = newId();
  db.prepare(
    `INSERT INTO production_documents (id, project_id, kind, title)
     VALUES (?, ?, ?, ?)`,
  ).run(id, input.project_id, input.kind, input.title ?? "");
  return getDocument(db, id);
}

export function insertDocumentRevision(
  db: DatabaseSync,
  input: {
    document_id: string;
    content: string;
    source: RevisionSource;
    blueprint_version_id?: string | null;
    /** revision this draft was edited from — must be a revision of
     *  the same document (also enforced by an insert trigger) */
    base_revision_id?: string | null;
    /** the chat instruction that produced this draft (LLM amends) */
    instruction_message_id?: string | null;
  },
): DocumentRevision {
  const doc = getDocument(db, input.document_id);
  if (input.base_revision_id) {
    // reject a base that belongs to another document — the trigger
    // is the backstop, this surfaces the right error code/message
    getDocumentRevision(db, input.document_id, input.base_revision_id);
  }
  if (input.instruction_message_id) {
    // the recorded directive must be a user turn of this project —
    // mirrored by the insert trigger; here it is a readable error
    const msg = db
      .prepare(
        `SELECT project_id, role FROM messages WHERE id = ?`,
      )
      .get(input.instruction_message_id) as
      | { project_id: string; role: string }
      | undefined;
    if (!msg) {
      throw new BadRequestError(
        "instruction_message_id does not reference a message",
      );
    }
    if (msg.project_id !== doc.project_id) {
      throw new BadRequestError(
        "instruction_message_id belongs to another project",
      );
    }
    if (msg.role !== "user") {
      throw new BadRequestError(
        "instruction_message_id must reference a user message",
      );
    }
  }
  const id = newId();
  db.prepare(
    `INSERT INTO document_revisions
       (id, document_id, project_id, rev_no, content, source,
        blueprint_version_id, base_revision_id, instruction_message_id,
        proposal_status, base_state_version)
     VALUES (?, ?, ?,
       (SELECT COALESCE(MAX(rev_no), 0) + 1 FROM document_revisions
         WHERE document_id = ?),
       ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    input.document_id,
    doc.project_id,
    input.document_id,
    input.content,
    input.source,
    input.blueprint_version_id ?? null,
    input.base_revision_id ?? null,
    input.instruction_message_id ?? null,
    doc.state_version,
  );
  return db
    .prepare(`SELECT ${revCols} FROM document_revisions WHERE id = ?`)
    .get(id) as unknown as DocumentRevision;
}

export function adoptDocumentRevision(
  db: DatabaseSync,
  input: {
    document_id: string;
    revision_id: string;
    expected_version: number;
  },
): ProductionDocument {
  const doc = getDocument(db, input.document_id);
  const rev = db
    .prepare(
      `SELECT ${revCols} FROM document_revisions WHERE id = ? AND document_id = ?`,
    )
    .get(input.revision_id, input.document_id) as unknown as
    | DocumentRevision
    | undefined;
  if (!rev) {
    throw new BadRequestError("revision does not belong to this document");
  }
  const res = db
    .prepare(
      `UPDATE production_documents
         SET adopted_revision_id = ?, state_version = state_version + 1
       WHERE id = ? AND state_version = ?`,
    )
    .run(input.revision_id, input.document_id, input.expected_version);
  if (res.changes === 0) {
    throw new ConflictError(
      `state_version mismatch: expected ${input.expected_version}, current ${doc.state_version}`,
    );
  }
  db.prepare(
    "UPDATE document_revisions SET proposal_status = 'adopted' WHERE id = ?",
  ).run(input.revision_id);
  db.prepare(
    `UPDATE document_revisions SET proposal_status = 'superseded'
       WHERE document_id = ? AND proposal_status = 'pending'`,
  ).run(input.document_id);
  return getDocument(db, input.document_id);
}

export function dismissDocumentRevision(
  db: DatabaseSync,
  input: {
    document_id: string;
    revision_id: string;
    expected_version: number;
  },
): ProductionDocument {
  const doc = getDocument(db, input.document_id);
  const res = db
    .prepare(
      `UPDATE document_revisions SET proposal_status = 'dismissed'
       WHERE id = ? AND document_id = ? AND proposal_status = 'pending'`,
    )
    .run(input.revision_id, input.document_id);
  if (res.changes === 0) {
    throw new BadRequestError("no pending proposal with that revision id");
  }
  const bump = db
    .prepare(
      `UPDATE production_documents SET state_version = state_version + 1
       WHERE id = ? AND state_version = ?`,
    )
    .run(input.document_id, input.expected_version);
  if (bump.changes === 0) {
    throw new ConflictError(
      `state_version mismatch: expected ${input.expected_version}, current ${doc.state_version}`,
    );
  }
  return getDocument(db, input.document_id);
}

/** Build a DocumentView; consistency is computed by the caller who has
 * the snapshot context (see repos/views.ts). */
export function toDocumentView(
  doc: ProductionDocument,
  revisions: DocumentRevision[],
  consistency: DocumentView["consistency"],
): DocumentView {
  return {
    ...doc,
    adoption: adoptionState(doc.adopted_revision_id, revisions),
    consistency,
    adopted_revision:
      revisions.find((r) => r.id === doc.adopted_revision_id) ?? null,
    pending_proposals: pendingProposals(revisions),
    revisions,
  };
}
