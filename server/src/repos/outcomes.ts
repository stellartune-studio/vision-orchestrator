import { DatabaseSync } from "node:sqlite";
import type { AmendmentOutcome, AmendmentOutcomeKind } from "@vo/shared";
import { newId } from "../domain/ids.ts";
import { BadRequestError } from "./errors.ts";

const cols =
  "id, project_id, instruction_message_id, assistant_message_id, " +
  "document_id, base_revision_id, blueprint_version_id, " +
  "outcome, result_revision_id, reject_reason, created_at";

export function listAmendmentOutcomes(
  db: DatabaseSync,
  projectId: string,
): AmendmentOutcome[] {
  return db
    .prepare(
      `SELECT ${cols} FROM amendment_outcomes
        WHERE project_id = ? ORDER BY rowid`,
    )
    .all(projectId) as unknown as AmendmentOutcome[];
}

function messageRole(
  db: DatabaseSync,
  messageId: string,
): { project_id: string; role: string } | undefined {
  return db
    .prepare(`SELECT project_id, role FROM messages WHERE id = ?`)
    .get(messageId) as { project_id: string; role: string } | undefined;
}

/**
 * Record what a revision directive produced. The composite FKs and the
 * insert trigger enforce the same rules — these pre-checks exist so a
 * violation fails with a readable error instead of a trigger abort.
 */
export function insertAmendmentOutcome(
  db: DatabaseSync,
  input: {
    project_id: string;
    instruction_message_id: string;
    assistant_message_id: string;
    document_id: string;
    base_revision_id: string;
    blueprint_version_id?: string | null;
    outcome: AmendmentOutcomeKind;
    result_revision_id?: string | null;
    reject_reason?: string | null;
  },
): AmendmentOutcome {
  const instruction = messageRole(db, input.instruction_message_id);
  if (!instruction || instruction.project_id !== input.project_id) {
    throw new BadRequestError(
      "instruction_message_id must be a message of this project",
    );
  }
  if (instruction.role !== "user") {
    throw new BadRequestError("instruction_message_id must be a user turn");
  }
  const reply = messageRole(db, input.assistant_message_id);
  if (!reply || reply.project_id !== input.project_id) {
    throw new BadRequestError(
      "assistant_message_id must be a message of this project",
    );
  }
  if (reply.role !== "assistant") {
    throw new BadRequestError(
      "assistant_message_id must be an assistant turn",
    );
  }
  const doc = db
    .prepare(`SELECT project_id FROM production_documents WHERE id = ?`)
    .get(input.document_id) as { project_id: string } | undefined;
  if (!doc || doc.project_id !== input.project_id) {
    throw new BadRequestError("document_id must belong to this project");
  }
  const base = db
    .prepare(
      `SELECT document_id, blueprint_version_id
         FROM document_revisions WHERE id = ?`,
    )
    .get(input.base_revision_id) as
    | { document_id: string; blueprint_version_id: string | null }
    | undefined;
  if (!base || base.document_id !== input.document_id) {
    throw new BadRequestError(
      "base_revision_id must be a revision of this document",
    );
  }
  // The outcome's basis is the base revision's: an amendment inherits
  // the blueprint version of the revision it edits (NULL counts).
  if (
    (input.blueprint_version_id ?? null) !==
    (base.blueprint_version_id ?? null)
  ) {
    throw new BadRequestError(
      "blueprint_version_id must match the base revision's basis",
    );
  }
  if (input.outcome === "saved") {
    if (!input.result_revision_id) {
      throw new BadRequestError(
        "saved outcome requires result_revision_id",
      );
    }
    if (input.result_revision_id === input.base_revision_id) {
      throw new BadRequestError(
        "result_revision_id must differ from base_revision_id",
      );
    }
    // A saved outcome must name the actual amendment this directive
    // produced — the llm revision built on this base by this
    // instruction, inheriting the base's blueprint basis. A revision
    // that only happens to live on the same document is not a result.
    const result = db
      .prepare(
        `SELECT document_id, source, base_revision_id,
                instruction_message_id, blueprint_version_id
           FROM document_revisions WHERE id = ?`,
      )
      .get(input.result_revision_id) as
      | {
          document_id: string;
          source: string;
          base_revision_id: string | null;
          instruction_message_id: string | null;
          blueprint_version_id: string | null;
        }
      | undefined;
    if (!result || result.document_id !== input.document_id) {
      throw new BadRequestError(
        "result_revision_id must be a revision of this document",
      );
    }
    if (result.source !== "llm") {
      throw new BadRequestError(
        "result_revision_id must be an llm-produced amendment",
      );
    }
    if (result.base_revision_id !== input.base_revision_id) {
      throw new BadRequestError(
        "result revision's base_revision_id must match this outcome",
      );
    }
    if (result.instruction_message_id !== input.instruction_message_id) {
      throw new BadRequestError(
        "result revision's instruction_message_id must match this outcome",
      );
    }
    if (
      (result.blueprint_version_id ?? null) !==
      (input.blueprint_version_id ?? null)
    ) {
      throw new BadRequestError(
        "result revision's blueprint_version_id must match the base's basis",
      );
    }
  } else if (input.result_revision_id) {
    throw new BadRequestError(
      "result_revision_id is only allowed for a saved outcome",
    );
  }
  if (input.outcome === "rejected" && !input.reject_reason?.trim()) {
    throw new BadRequestError(
      "rejected outcome requires a non-empty reject_reason",
    );
  }
  if (input.outcome !== "rejected" && input.reject_reason != null) {
    throw new BadRequestError(
      "reject_reason is only allowed for a rejected outcome",
    );
  }

  const id = newId();
  db.prepare(
    `INSERT INTO amendment_outcomes
       (id, project_id, instruction_message_id, assistant_message_id,
        document_id, base_revision_id, blueprint_version_id,
        outcome, result_revision_id, reject_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.instruction_message_id,
    input.assistant_message_id,
    input.document_id,
    input.base_revision_id,
    input.blueprint_version_id ?? null,
    input.outcome,
    input.result_revision_id ?? null,
    input.reject_reason ?? null,
  );
  return db
    .prepare(`SELECT ${cols} FROM amendment_outcomes WHERE id = ?`)
    .get(id) as unknown as AmendmentOutcome;
}
