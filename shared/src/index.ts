/**
 * @vo/shared — React-independent domain types and API DTOs for
 * Vision Orchestrator (screen name: 制作設計図 / ProjectBlueprint).
 *
 * Status model is three axes, never a single value:
 *   1. adoption: undecided / proposed-only / adopted
 *   2. pending proposals: count + which revisions (a dismissed or
 *      superseded proposal never counts as "unconfirmed")
 *   3. consistency (documents/generations only): in-sync vs
 *      needs_recheck — derived, separate from approval.
 */

export type ItemKind =
  | "purpose"
  | "intent"
  | "audience"
  | "worldview"
  | "story_segment"
  | "shot"
  | "camera_work"
  | "fixed_constraint"
  | "material"
  | "output_policy"
  | "other";

export const ITEM_KINDS: readonly ItemKind[] = [
  "purpose",
  "intent",
  "audience",
  "worldview",
  "story_segment",
  "shot",
  "camera_work",
  "fixed_constraint",
  "material",
  "output_policy",
  "other",
];

/** Axis 1 — adoption state of an item or document. */
export type AdoptionState = "undecided" | "proposed_only" | "adopted";

/** Axis 3 — consistency of a document/generation vs current blueprint. */
export type ConsistencyState = "in_sync" | "needs_recheck";

export type ProposalStatus =
  | "pending"
  | "adopted"
  | "dismissed"
  | "superseded";

export type RevisionSource = "user" | "llm";

export interface Project {
  id: string;
  name: string;
  purpose_note: string | null;
  template_key: string | null;
  template_version: number | null;
  /** set when archived; archived works hide from the default library
   *  list but keep all content — reversible, never destructive */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Compact per-project status for the project list — derived counts,
 * never a merged "state". The three axes stay distinct: pending
 * proposals are NOT adopted content, and a recheck flag does not
 * revoke an approval.
 */
export interface ProjectSummary {
  /** adopted design items (axis 1) */
  adopted_items: number;
  /** pending proposals across items + documents (axis 2) */
  pending_proposals: number;
  /** latest blueprint version number, if any */
  latest_version_no: number | null;
  /** status of the most recent generation record, if any */
  latest_generation: GenerationStatus | null;
  /** asset id of the most recent SUCCEEDED output — the list screen
   *  shows it as the work's thumbnail; read-only, never an approval */
  latest_output_asset_id: string | null;
  /** its media kind, so the list knows how to render the thumbnail */
  latest_output_kind: "image" | "video" | null;
}

/** GET /api/projects — Project plus its list summary. */
export interface ProjectListItem extends Project {
  summary: ProjectSummary;
}

export interface Message {
  id: string;
  project_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export interface ItemRevision {
  id: string;
  item_id: string;
  rev_no: number;
  /** Free-form content; structured payloads are JSON-encoded. */
  content: string;
  source: RevisionSource;
  proposal_status: ProposalStatus;
  /** Item's state_version when this proposal was made. A pending
   * proposal whose base is stale is shown as "based on older base". */
  base_state_version: number;
  created_at: string;
}

export interface DesignItem {
  id: string;
  project_id: string;
  kind: ItemKind;
  seq: number;
  parent_item_id: string | null;
  label: string;
  adopted_revision_id: string | null;
  state_version: number;
  created_at: string;
}

/** Item + derived view sent to the client. */
export interface ItemView extends DesignItem {
  adoption: AdoptionState;
  adopted_revision: ItemRevision | null;
  pending_proposals: ItemRevision[];
  /** pending proposals whose base_state_version is stale */
  stale_proposal_count: number;
  revisions: ItemRevision[];
}

export interface BlueprintVersion {
  id: string;
  project_id: string;
  version_no: number;
  note: string | null;
  template_key: string | null;
  template_version: number | null;
  created_at: string;
}

export interface BlueprintVersionItem {
  blueprint_version_id: string;
  item_id: string;
  revision_id: string;
  seq: number;
  parent_item_id: string | null;
  kind: ItemKind;
  label: string;
}

export interface BlueprintVersionCharacter {
  blueprint_version_id: string;
  character_id: string;
  character_revision_id: string;
  base_image_asset_id: string | null;
}

export interface BlueprintVersionAsset {
  blueprint_version_id: string;
  asset_id: string;
  role: string;
}

export interface BlueprintVersionDetail extends BlueprintVersion {
  items: BlueprintVersionItem[];
  characters: BlueprintVersionCharacter[];
  assets: BlueprintVersionAsset[];
}

export interface ProductionDocument {
  id: string;
  project_id: string;
  kind: "script" | "storyboard";
  title: string;
  adopted_revision_id: string | null;
  state_version: number;
  created_at: string;
}

export interface DocumentRevision {
  id: string;
  document_id: string;
  rev_no: number;
  content: string;
  source: RevisionSource;
  /** Blueprint version this revision was drafted from. */
  blueprint_version_id: string | null;
  /** Revision this draft was edited from (manual or LLM amendment),
   *  when declared. NULL for roots and pre-provenance rows — never
   *  guessed after the fact. */
  base_revision_id: string | null;
  /** The chat instruction that produced this draft (LLM amendments). */
  instruction_message_id: string | null;
  proposal_status: ProposalStatus;
  base_state_version: number;
  created_at: string;
}

export interface DocumentView extends ProductionDocument {
  adoption: AdoptionState;
  consistency: ConsistencyState;
  adopted_revision: DocumentRevision | null;
  pending_proposals: DocumentRevision[];
  revisions: DocumentRevision[];
}

/** What a revision directive produced — written in the same
 *  transaction as the assistant reply (and the saved draft, when
 *  there is one). A directive that never completed (409 race,
 *  provider failure) or predates the record has NO row — its result
 *  is "unknown", never guessed from the reply text. */
export type AmendmentOutcomeKind = "saved" | "reply_only" | "rejected";

export interface AmendmentOutcome {
  id: string;
  project_id: string;
  /** The user instruction the directive came from. */
  instruction_message_id: string;
  /** The assistant reply paired with the recorded result. */
  assistant_message_id: string;
  document_id: string;
  base_revision_id: string;
  blueprint_version_id: string | null;
  outcome: AmendmentOutcomeKind;
  /** The pending revision actually stored — set iff outcome='saved'. */
  result_revision_id: string | null;
  /** Why the amendment was refused — set iff outcome='rejected'. */
  reject_reason: string | null;
  created_at: string;
}

export interface Character {
  id: string;
  name: string;
  created_at: string;
}

export interface CharacterTraits {
  /** e.g. { hair: "short black bob", outfit: "red jacket" } */
  locked?: Record<string, string>;
  changeable?: Record<string, string>;
}

export interface CharacterProfile {
  persona?: string;
  appearance?: string;
  traits?: CharacterTraits;
  [key: string]: unknown;
}

export interface CharacterRevision {
  id: string;
  character_id: string;
  rev_no: number;
  /** JSON-encoded CharacterProfile */
  profile: string;
  base_image_asset_id: string | null;
  created_at: string;
}

export interface CharacterView extends Character {
  revisions: CharacterRevision[];
}

export interface ProjectCharacter {
  pin_version: number;
  project_id: string;
  character_id: string;
  character_revision_id: string;
  created_at: string;
}

// ---- Character sheet (shared workbench) ----

/** View slots a sheet can place images into. */
export const CHARACTER_SHEET_VIEWS = [
  "front",
  "side",
  "back",
  "expressions",
] as const;

export type CharacterSheetView = (typeof CHARACTER_SHEET_VIEWS)[number];

/** Editable character-sheet text fields. */
export const CHARACTER_SHEET_FIELDS = [
  "persona",
  "appearance",
  "outfit",
  "traits",
  "colors",
  "expression_memo",
] as const;

export type CharacterSheetField = (typeof CHARACTER_SHEET_FIELDS)[number];

/** Sheet fields that can be pinned as fixed generation conditions.
 *  `persona` and `appearance` stay editable notes — they reach the
 *  generation context through the profile, never through locks. */
export const CHARACTER_SHEET_LOCKABLE_FIELDS = [
  "outfit",
  "traits",
  "colors",
  "expression_memo",
] as const;

export type CharacterSheetLockField =
  (typeof CHARACTER_SHEET_LOCKABLE_FIELDS)[number];

/**
 * Editable character-sheet fields. Persisted inside a character
 * revision's `profile` JSON — a save is always a NEW revision, and
 * the saving work's pin moves to it. Text is remembered, never
 * auto-locked: only fields present in `locked_fields` mirror into
 * `traits.locked` for the consult/generation context. Clearing the
 * text or removing the lock drops the trait on the next save.
 */
export interface CharacterSheet {
  persona: string;
  appearance: string;
  outfit: string;
  traits: string;
  colors: string;
  expression_memo: string;
  placed_views: CharacterSheetView[];
  locked_fields: CharacterSheetLockField[];
}

/**
 * Explicit sheet save — the only operation that both writes a
 * character revision AND moves the work's pin. Never starts
 * generation or calls an LLM.
 */
export interface SaveCharacterSheetRequest {
  /** Existing library character; omit to create a new one. */
  character_id?: string;
  /**
   * Required iff `character_id` is absent. When combined with
   * `character_id` and different from the current name, the
   * character is renamed inside the same save transaction.
   */
  name?: string;
  sheet: CharacterSheet;
  /**
   * Revision the displayed sheet was loaded from. Required when the
   * character already has revisions — its base image carries
   * forward so a sheet save never silently drops the reference.
   */
  base_revision_id?: string;
  /**
   * New base image for the saved revision. Must be an asset owned by
   * this character. When absent, the base revision's image carries
   * forward unchanged.
   */
  base_image_asset_id?: string;
  /**
   * Revision currently pinned in this work (`null` when unpinned).
   * A mismatch is a 409 conflict, never a silent overwrite.
   */
  expected_revision_id: string | null;
}

export interface SaveCharacterSheetResponse {
  character: CharacterView;
  revision: CharacterRevision;
  pin: ProjectCharacter;
}

// ---- Workbench background (shared workbench) ----

/** Preset backdrop keys offered by the shared workbench scene tab.
 *  Presets are display-level fixtures today; the selection+lock is
 *  what persists per work. */
export const WORKBENCH_BACKDROPS = ["rain", "studio", "library"] as const;

export type WorkbenchBackdrop = (typeof WORKBENCH_BACKDROPS)[number];

export interface WorkbenchBackground {
  backdrop_key: WorkbenchBackdrop;
  locked: boolean;
  /** optimistic-concurrency counter — every save bumps it; a stale
   *  `expected_version` save is rejected with 409 */
  workbench_version: number;
  updated_at: string;
}

/**
 * Persist a work's backdrop selection and pin state. A plain
 * settings write with no generation side effect — but NOT a blind
 * overwrite: `expected_version` must match the current row (null only
 * when no row exists yet), so a stale screen cannot silently replace
 * a newer setting.
 */
export interface SaveWorkbenchBackgroundRequest {
  backdrop_key: WorkbenchBackdrop;
  locked: boolean;
  expected_version: number | null;
}

export interface Asset {
  id: string;
  owner_kind: "project" | "character";
  owner_id: string;
  kind: string;
  path: string;
  mime: string | null;
  sha256: string | null;
  meta: string | null;
  selected: number;
  selection_version: number;
  created_at: string;
}

export type GenerationStatus = "queued" | "running" | "succeeded" | "failed";

/** Server-computed candidate for the bundled Qwen reference workflow. */
export interface QwenReferenceSize {
  asset_id: string;
  source_sha256: string;
  source_width: number;
  source_height: number;
  requested_width: number | null;
  requested_height: number | null;
  resolution: number;
  width: number;
  height: number;
}

export interface GenerationRecord {
  id: string;
  project_id: string;
  kind: "image" | "video";
  status: GenerationStatus;
  blueprint_version_id: string | null;
  document_revision_id: string | null;
  /** JSON snapshot of the exact payload sent to the backend. */
  inputs: string;
  backend: string;
  backend_job_id: string | null;
  output_asset_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Scene input draft (preview only — never persisted, never a
// generation input) ----

/** A provenance pointer — always an entity the draft was actually
 *  built from, never an inferred or LLM-supplied id. */
export interface SceneDraftSource {
  kind: "document_revision" | "item_revision" | "character_revision" | "asset";
  id: string;
  /** human-facing hint, e.g. item label or "台本 版 #3" */
  label?: string;
}

export interface SceneDraftSection {
  /** verbatim approved content — never paraphrased or weakened */
  content: string;
  sources: SceneDraftSource[];
}

export type SceneDraftQuestionKind =
  /** piece-level motion/posture words coexist with the scene's own —
   *  the two scopes are kept separate; this frame's pose is
   *  unresolved and for the director to confirm */
  | "posture_scope"
  /** visual style (anime / photorealistic / ...) */
  | "style"
  /** colour vs monochrome etc. */
  | "color"
  /** how many MAIN subjects appear — a separate axis from
   *  background people */
  | "main_subject"
  /** whether background people are allowed and how many —
   *  never inferred from the main subject's description */
  | "background_people"
  /** composition / camera work */
  | "composition"
  /** negative prompt policy — reported per inspection result,
   *  never auto-filled */
  | "negative_policy";

/** Inspection outcome for one aspect — the draft never claims a
 *  value is agreed or resolved. */
export type SceneDraftCheckStatus =
  /** related text exists in INSPECTED sources — interpretation and
   *  applicable scope still need the director's confirmation;
   *  "未定/候補/禁止" phrasing stays verbatim, nothing is promoted
   *  to a decided condition */
  | "related_text_found"
  /** every relevant source was inspected and no related text was
   *  found — a statement about the INSPECTED range only */
  | "none_found"
  /** sources that could carry relevant information exist but their
   *  content was not inspected — coverage is incomplete */
  | "not_inspected";

export interface SceneDraftQuestion {
  kind: SceneDraftQuestionKind;
  note: string;
  status: SceneDraftCheckStatus;
  /** verbatim lines relating to this aspect, taken from INSPECTED
   *  sources — displayed as-found, never promoted to a decision */
  related: SceneDraftSection[];
  /** relevant sources whose content was NOT inspected */
  uninspected: SceneDraftSource[];
  /** sources tied to the question itself (e.g. both scopes of a
   *  posture tension) */
  sources: SceneDraftSource[];
}

/** A blueprint reference that could not be resolved — reported
 *  explicitly, never silently skipped. Distinct from a found source
 *  whose content happens to be empty. */
export interface SceneDraftUnresolvedSource {
  source: SceneDraftSource;
  reason: "not_found";
}

/**
 * Reorganization of already-approved content for ONE scene —
 * a draft proposal surface for the director, produced
 * deterministically from the frozen blueprint version and the
 * document's currently adopted revision. `status` is always
 * "preview": it is not saved, not adopted, and not submitted to any
 * generation backend.
 */
export interface SceneInputDraftContent {
  status: "preview";
  project_id: string;
  blueprint_version_id: string;
  blueprint_version_no: number;
  document_id: string;
  document_revision_id: string;
  document_rev_no: number;
  /** this frame — the adopted document text, verbatim */
  scene: SceneDraftSection;
  /** fixed conditions carried over verbatim; identical contents are
   *  deduplicated while keeping EVERY source */
  constraints: SceneDraftSection[];
  /** piece-level background (intent / worldview / audience /
   *  character appearance) — context for the whole work, NOT
   *  necessarily drawn in this frame */
  context: SceneDraftSection[];
  /** adopted descriptions carrying no scene/constraint meaning the
   *  draft can classify (output policy, purpose, material notes,
   *  ...) — kept verbatim with provenance, never silently dropped */
  unclassified: SceneDraftSection[];
  /** unresolved points — surfaced, never auto-filled. `status`
   *  distinguishes "related text found", "none found in the
   *  inspected range" and "inspection incomplete" */
  open_questions: SceneDraftQuestion[];
  /** blueprint references that could not be resolved — reported
   *  explicitly instead of being skipped */
  unresolved_sources: SceneDraftUnresolvedSource[];
  /** selected assets referenced by the frozen version whose CONTENT
   *  the draft did not inspect — their presence must not be read as
   *  "no related instruction" */
  uninspected_sources: SceneDraftSource[];
  /** image/base assets the blueprint pins — provenance only;
   *  `content_inspected` is always false today (the draft reads no
   *  asset content) */
  ref_assets: { id: string; label: string; content_inspected: boolean }[];
}

export interface SceneInputDraft extends SceneInputDraftContent {
  /** Deterministic preview identity; binds displayed content to its target. */
  payload_version: number;
  builder_version: number;
  digest: string;
}

export interface SceneInputDraftSummary {
  id: string;
  project_id: string;
  blueprint_version_id: string;
  document_id: string;
  document_revision_id: string;
  saved_at: string;
  payload_version: number;
  builder_version: number;
  digest: string;
}

/** Immutable save-time copy of the exact deterministic preview. */
export interface SceneInputDraftRecord extends SceneInputDraftSummary {
  snapshot: SceneInputDraft;
}

export interface SaveSceneInputDraftRequest {
  blueprint_version_id: string;
  document_id: string;
  document_revision_id: string;
  digest: string;
}


/** Director review progress is separate from the immutable saved snapshot and from approval. */
export type SceneDraftReviewStatus = "unconfirmed" | "in_progress" | "confirmed";

export type SceneDraftReviewItemKind =
  | "scene"
  | "constraint"
  | "context"
  | "unclassified"
  | "open_question"
  | "unresolved_source"
  | "uninspected_source";

/** A read-only source projection plus mutable, director-entered review fields. */
export interface SceneInputDraftReviewItem {
  id: string;
  pointer: string;
  kind: SceneDraftReviewItemKind;
  label: string;
  source_text: string;
  source_status: SceneDraftCheckStatus | null;
  status: SceneDraftReviewStatus;
  answer: string;
  memo: string;
}

export interface SceneInputDraftReviewIssue {
  id: string;
  text: string;
  status: SceneDraftReviewStatus;
  answer: string;
  memo: string;
}

export interface SceneInputDraftResumeTarget {
  draft_id: string;
  issue_id: string;
}

export interface SceneInputDraftReview {
  project_id: string;
  draft_id: string;
  /** 0 means no explicit save yet. */
  version: number;
  persisted: boolean;
  updated_at: string | null;
  items: SceneInputDraftReviewItem[];
  unresolved_issues: SceneInputDraftReviewIssue[];
  resume_target: SceneInputDraftResumeTarget | null;
}

/** Explicit full-state save guarded by expected_version; 409 never overwrites newer progress. */
export interface SaveSceneInputDraftReviewRequest {
  expected_version: number;
  items: Array<{
    id: string;
    status: SceneDraftReviewStatus;
    answer: string;
    memo: string;
  }>;
  unresolved_issues: SceneInputDraftReviewIssue[];
  resume_target: SceneInputDraftResumeTarget | null;
}

/** GET /api/projects/:id/state — everything needed to resume a project. */
export interface ProjectState {
  project: Project;
  items: ItemView[];
  messages: Message[];
  blueprint_versions: BlueprintVersion[];
  documents: DocumentView[];
  characters: ProjectCharacter[];
  character_views: CharacterView[];
  assets: Asset[];
  generations: GenerationRecord[];
  amendment_outcomes: AmendmentOutcome[];
  scene_input_drafts: SceneInputDraftSummary[];
  /** Persisted workbench backdrop selection+pin; null when never set. */
  workbench_background: WorkbenchBackground | null;
}

export interface ServerMeta {
  node: string;
  llm_provider: "mock" | "openai-compatible" | "kaname";
  gen_backend: "mock" | "comfy-sdk";
  /** Active explicitly selected integration profile, if any. */
  gen_profile?: "default" | "qwen-image-2.1-turbo" | "qwen-image-2.1-turbo-edit-single";
  /** media kinds the active generation backend accepts */
  gen_kinds: ("image" | "video")[];
  /** true when either integration is mocked — shown as a UI badge. */
  mock: boolean;
}

// ---- API payloads ----

export interface PostMessageRequest {
  content: string;
  /** When set, the message is a revision directive whose base is this
   *  document revision — validated server-side to belong to the
   *  project's document. */
  document_revision_id?: string;
}

export interface PostMessageResponse {
  reply: string;
  proposals: { item_id: string; revision: ItemRevision }[];
  rejected_proposals: { reason: string; draft: unknown }[];
  /** For revision-directive messages: the saved amendment draft
   *  (pending). NULL when the model only replied — never presented
   *  as a saved amendment. */
  document_revision?: DocumentRevision | null;
  /** The model emitted an amendment that failed validation. */
  rejected_amendment?: string;
}

export interface AdoptRequest {
  revision_id: string;
  /** Must equal the entity's current state_version, else 409. */
  expected_version: number;
}

export interface ApiError {
  error: string;
  code?:
    | "conflict"
    | "not_found"
    | "bad_request"
    | "unprocessable"
    | "payload_too_large";
  details?: unknown;
}
export type { WorkflowValue, WorkflowNode, WorkflowSource, WorkflowCatalogEntry, WorkflowSelection, SavedWorkflowSelection, EnvironmentPlan, EnvironmentCatalog, SetupRun } from "./environment.ts";
export type { ComparisonSelection } from "./comparison.ts";
