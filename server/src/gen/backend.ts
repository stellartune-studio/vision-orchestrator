import type { WorkflowSelection } from "@vo/shared";
/**
 * GenerationBackend — the contract between the app and media
 * generation. Separate from the director LLM layer: the chat model
 * and the image/video backend are independent concerns.
 */

export interface GenerationInput {
  /** which media kind this payload produces */
  kind: "image" | "video";
  /** exact prompt text sent to the backend */
  prompt: string;
  negative_prompt?: string;
  /** resolved reference image file paths (capability-gated) */
  ref_images: string[];
  settings: {
    workflow_selection?: WorkflowSelection;
    width?: number;
    height?: number;
    seed?: number;
    [key: string]: unknown;
  };
  /** provenance: what approved inputs produced this payload */
  resolved_refs: {
    blueprint_version_id: string;
    story_scene_id?: string;
    story_scene_revision_id?: string;
    item_revision_ids: string[];
    character_revision_ids: string[];
    base_image_asset_ids: string[];
    /** asset ids behind ref_images, in the same order (character base
     *  images first, then selected image materials) */
    ref_image_asset_ids: string[];
    /** all selected material assets snapshotted in the blueprint */
    asset_ids: string[];
    /** subset of asset_ids actually consumed by this input — on a
     *  successful build every selected material was used, since
     *  unusable materials are rejected instead of dropped */
    used_asset_ids: string[];
    document_revision_id?: string | null;
    /** adopted camera_work item revisions captured in the snapshot —
     *  empty when the item was left unspecified */
    camera_work_revision_ids?: string[];
    /** subset of camera_work_revision_ids actually injected into this
     *  prompt — empty for image kind, unsupported workflows, and
     *  prompt_verbatim mode; never read this field on image runs as
     *  "applied" */
    camera_work_applied_revision_ids?: string[];
    /** sha256 of the bundled graph content the camera direction was
     *  verified against — present only when injection happened */
    camera_work_verified_graph_sha256?: string;
    /** Explicit image-edit source, separate from implicit approved refs. */
    edit_source_asset_id?: string;
    edit_source_sha256?: string;
    /** backend-side facts (workflow file, model, nodes) filled by the
     *  adapter before the record is persisted */
    backend?: Record<string, unknown>;
  };
}

export interface GenerationCapabilities {
  kinds: readonly ("image" | "video")[];
  /** can this backend consume reference/base images? */
  ref_image: boolean;
  /** max reference images per job; inputs beyond this are rejected,
   *  never silently dropped. undefined = no specific limit. */
  max_ref_images?: number;
}

export interface GenerationJob {
  backend_job_id: string;
}

export interface GenerationPollResult {
  status: "running" | "succeeded" | "failed";
  /** absolute paths this attempt staged. On success the first file
   *  becomes the output asset and the rest are removed; on failure —
   *  or when a racing poll already committed — all of them are
   *  removed. Files not listed here are not the handler's to clean. */
  output_files?: string[];
  error?: string;
}

export interface GenerationBackend {
  /** Drop VO-owned client references only; does not unload remote models. */
  releaseLocalReferences?(): void;
  /** Only after local and remote jobs are idle and a target has been verified. */
  configureConnection?(endpoint: string): void;
  readonly name: string;
  readonly isMock: boolean;
  readonly capabilities: GenerationCapabilities;
  /** facts persisted into resolved_refs.backend for traceability
   *  (workflow file, model name, key nodes) */
  describe?(input?: GenerationInput): Record<string, unknown>;
  submit(
    input: GenerationInput,
    ctx: { project_id: string; generation_id: string },
  ): Promise<GenerationJob>;
  /** Locate a job this generation may already own — used when a
   *  submit's response was lost so the record can re-attach without
   *  a fresh submission. null/undefined = no lookup support. */
  findJob?(ctx: {
    project_id: string;
    generation_id: string;
  }): Promise<GenerationJob | null>;
  /** Request remote cancellation; polling determines the terminal result. */
  cancel?(job: GenerationJob): Promise<void>;
  poll(
    job: GenerationJob,
    ctx: {
      project_id: string;
      generation_id: string;
      /** output node recorded at submit time — a rehydrated poll does
       *  not re-derive the workflow from scratch */
      output_node?: string;
    },
  ): Promise<GenerationPollResult>;
}

/** Definitive local validation failure or explicit remote rejection, never a transport timeout. */
export class GenerationRejectedError extends Error {}

/** The backend reports the remote job as absent — a known-terminal
 *  lookup distinct from a transport failure or "still running". */
export class JobNotFoundError extends Error {}
