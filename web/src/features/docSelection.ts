import type {
  DocumentRevision,
  DocumentView,
  GenerationRecord,
  ProjectState,
} from "@vo/shared";
import { DOC_LABEL } from "./labels.ts";

/**
 * A document usable for generation: its ADOPTED revision derives from
 * the target blueprint version. The candidate identity is the revision
 * id — a document id alone can't survive adoption moving to a newer
 * revision between the user's pick and the submit.
 */
export interface DocCandidate {
  doc: DocumentView;
  rev: DocumentRevision;
}

export function docCandidatesFor(
  state: ProjectState,
  blueprintVersionId: string | undefined,
): DocCandidate[] {
  if (!blueprintVersionId) return [];
  return state.documents
    .filter(
      (d) =>
        d.adopted_revision !== null &&
        d.adopted_revision.blueprint_version_id === blueprintVersionId,
    )
    .map((d) => ({ doc: d, rev: d.adopted_revision as DocumentRevision }));
}

export function docCandidateLabel(
  c: DocCandidate,
  translate?: (key: string, values?: Record<string, string | number>) => string,
): string {
  const kind = translate?.(`content.doc.${c.doc.kind}`) ?? DOC_LABEL[c.doc.kind];
  return c.doc.title
    ? translate
      ? translate("generation.documentCandidateTitled", { title: c.doc.title, kind, version: c.rev.rev_no })
      : `${c.doc.title} (${kind} v${c.rev.rev_no})`
    : translate
      ? translate("generation.documentCandidate", { kind, version: c.rev.rev_no })
      : `${kind} v${c.rev.rev_no}`;
}

export type DocChoiceResolution =
  /** no approved document derives from the target version */
  | { kind: "none" }
  /** exactly one candidate — picked implicitly, never silently changed */
  | { kind: "auto"; candidate: DocCandidate }
  /** several candidates, nothing picked yet */
  | { kind: "unselected" }
  /** the picked revision is still the adopted one for this version */
  | { kind: "chosen"; candidate: DocCandidate }
  /** the picked revision lost adoption or left the candidate set —
   *  never auto-switch to the document's newer adopted revision */
  | { kind: "stale"; pickedRev: DocumentRevision | null };

export function resolveDocChoice(
  candidates: DocCandidate[],
  pickedRevId: string | null,
  allDocuments: DocumentView[],
): DocChoiceResolution {
  if (candidates.length === 0) {
    return pickedRevId
      ? { kind: "stale", pickedRev: findRev(allDocuments, pickedRevId) }
      : { kind: "none" };
  }
  if (!pickedRevId) {
    return candidates.length === 1
      ? { kind: "auto", candidate: candidates[0] }
      : { kind: "unselected" };
  }
  const hit = candidates.find((c) => c.rev.id === pickedRevId);
  if (hit) return { kind: "chosen", candidate: hit };
  return { kind: "stale", pickedRev: findRev(allDocuments, pickedRevId) };
}

function findRev(
  docs: DocumentView[],
  revId: string,
): DocumentRevision | null {
  for (const d of docs) {
    const r = d.revisions.find((x) => x.id === revId);
    if (r) return r;
  }
  return null;
}

/** What the resolved choice contributes to the request body. */
export function chosenRevisionId(r: DocChoiceResolution): string | null {
  return r.kind === "auto" || r.kind === "chosen"
    ? r.candidate.rev.id
    : null;
}

/**
 * Why a recorded generation cannot be re-issued as a new request.
 * Retry re-uses the RECORDED blueprint + document revision — it must
 * never fall through to "let the server pick whichever document is
 * approved now", which would silently substitute the document.
 */
export function retryBlockReason(
  rec: GenerationRecord,
  documents: DocumentView[],
  translate?: (key: string) => string,
): string | null {
  if (!rec.blueprint_version_id) {
    return translate?.("generation.retryMissingBlueprint") ?? "This record has no blueprint version stored for retry.";
  }
  if (!rec.document_revision_id) {
    return translate?.("generation.retryMissingDocument") ?? "This record has no document version stored for generation. Confirm the document, then run a new generation.";
  }
  const doc = documents.find((d) =>
    d.revisions.some((r) => r.id === rec.document_revision_id),
  );
  const rev = doc?.revisions.find((r) => r.id === rec.document_revision_id);
  if (!doc || !rev) {
    return translate?.("generation.retryDocumentUnavailable") ?? "The document version used for the original generation is not available in the current state.";
  }
  if (doc.adopted_revision_id !== rev.id) {
    return translate?.("generation.retryDocumentNotAdopted") ?? "The document version used for the original generation is not the currently approved version.";
  }
  if (rev.blueprint_version_id !== rec.blueprint_version_id) {
    return translate?.("generation.retryDocumentWrongBlueprint") ?? "The original document version no longer comes from the target blueprint version.";
  }
  return null;
}
