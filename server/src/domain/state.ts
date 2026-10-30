import type {
  AdoptionState,
  ConsistencyState,
  ItemRevision,
  DocumentRevision,
} from "@vo/shared";

/**
 * Axis-1 derivation: adoption state from revisions + adopted pointer.
 * A proposal whose base_state_version no longer matches is "stale" —
 * still pending but shown as based on an older base, never
 * auto-applied.
 */
export function adoptionState(
  adoptedRevisionId: string | null,
  revisions: { proposal_status: string }[],
): AdoptionState {
  if (adoptedRevisionId) return "adopted";
  return revisions.length > 0 ? "proposed_only" : "undecided";
}

export function pendingProposals<T extends { proposal_status: string }>(
  revisions: T[],
): T[] {
  return revisions.filter((r) => r.proposal_status === "pending");
}

export function isStaleProposal(
  rev: Pick<ItemRevision | DocumentRevision, "proposal_status" | "base_state_version">,
  currentStateVersion: number,
): boolean {
  return (
    rev.proposal_status === "pending" &&
    rev.base_state_version !== currentStateVersion
  );
}

/**
 * Axis-3: document consistency. The adopted document revision carries
 * the blueprint version it was drafted from; when the project's current
 * blueprint no longer matches that snapshot — adopted item revisions,
 * their order/parent links, pinned character revisions, or selected
 * assets — the document needs re-check. Approval itself is untouched:
 * a document can be both approved and needs_recheck.
 */
export function documentConsistency(
  adoptedDocRevision: Pick<DocumentRevision, "blueprint_version_id"> | null,
  snapshotSignature: string | null,
  currentSignature: string,
): ConsistencyState {
  if (!adoptedDocRevision || snapshotSignature === null) return "in_sync";
  return snapshotSignature === currentSignature
    ? "in_sync"
    : "needs_recheck";
}
