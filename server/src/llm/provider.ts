import type { ItemView, Message, ProposalStatus } from "@vo/shared";

/**
 * DirectorLLMProvider — the contract between the app and the director
 * chat LLM. Provider-specific request/response shapes never leak into
 * the domain model or UI: both the mock and the OpenAI-compatible
 * provider implement this same contract.
 */

export interface ChatTurn {
  role: Message["role"];
  content: string;
}

/** A proposed blueprint change. `base_state_version` records the item
 * state the proposal was made against — the server stamps it when
 * saving, so a stale-based proposal is never applied as current. */
export interface ProposalDraft {
  item_id?: string;
  item_label?: string;
  content: string;
}

export interface DirectorInput {
  project_name: string;
  messages: ChatTurn[];
  /** Current blueprint items WITH adoption state (from DB, not summary) */
  items: ItemView[];
  characters: {
    name: string;
    locked_traits: Record<string, string>;
    has_base_image: boolean;
  }[];
}

export interface DirectorOutput {
  /** user-facing reply text */
  reply: string;
  /** blueprint change proposals — saved as unconfirmed revisions */
  proposals: ProposalDraft[];
}

/**
 * A revision directive against ONE production document: the director
 * picks a concrete revision as the edit base, and the model returns a
 * user-facing explanation plus the full amended document body. This is
 * deliberately a separate contract from converse()'s blueprint
 * proposals — an amendment is document text, not a design-item draft.
 *
 * All identifiers (document / base revision / blueprint version) are
 * resolved and validated server-side BEFORE the call; the model only
 * sees content, never ids it could redirect the save to.
 */
export interface DocAmendInput {
  project_name: string;
  /** the director's revision directive (the latest user turn) */
  instruction: string;
  /** conversation history for context (already includes the directive) */
  messages: ChatTurn[];
  document: {
    kind: "script" | "storyboard";
    title: string;
    base_rev_no: number;
    base_status: ProposalStatus;
    /** the full text being edited — reproduce faithfully except the
     *  requested change */
    base_content: string;
  };
  /** Production standards frozen in the SAME blueprint version the
   *  base revision derives from. NULL when the base has no blueprint
   *  link. Live working state is never passed as the basis — drift
   *  goes in drift_notes instead. */
  frozen_context: {
    version_no: number;
    /** adopted item contents captured in the snapshot */
    items: { kind: string; label: string; content: string }[];
    /** fixed_constraint items of that snapshot — must be respected */
    fixed_constraints: { label: string; content: string }[];
    /** character revisions pinned in that snapshot */
    characters: {
      name: string;
      locked_traits: Record<string, string>;
      has_base_image: boolean;
    }[];
  } | null;
  /** How the live project state diverges from the frozen version —
   *  informational only, clearly separated from the basis. */
  drift_notes: string[];
}

export interface DocAmendOutput {
  /** user-facing explanation — by itself this is NOT a saved draft */
  reply: string;
  /** raw proposed new document body — UNVALIDATED model output.
   *  The server runs it through validateAmendment before it may be
   *  stored; a malformed block is never saved. */
  amendment?: unknown;
  /** The reply carried an amendment-shaped block that could not even
   *  be read (e.g. a fenced JSON block that fails to parse, or a
   *  block with no amendment field). Lets the caller distinguish a
   *  malformed amendment from a plain reply-only turn. */
  amendment_error?: string;
}

export interface DirectorLLMProvider {
  readonly name: string;
  readonly isMock: boolean;
  converse(input: DirectorInput): Promise<DirectorOutput>;
  reviseDocument(input: DocAmendInput): Promise<DocAmendOutput>;
}
