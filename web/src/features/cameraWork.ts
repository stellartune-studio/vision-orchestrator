import type { GenerationRecord } from "@vo/shared";

export type CameraWorkState =
  | "applied"
  | "notAppliedKind"
  | "notAppliedVerbatim"
  | "notAppliedWorkflow"
  | null;

/**
 * Derive the camera_work display state from a generation record's
 * persisted inputs. Mirrors buildGenerationInput: adopted revisions are
 * listed in camera_work_revision_ids, applied ones (verified H3 prompt
 * path only) in camera_work_applied_revision_ids. prompt_verbatim
 * selections never receive the injected sentence.
 */
export function cameraWorkStateOf(rec: GenerationRecord): CameraWorkState {
  let inputs: {
    resolved_refs?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  } = {};
  try {
    inputs = JSON.parse(rec.inputs) as typeof inputs;
  } catch {
    /* keep {} */
  }
  const refs = (inputs.resolved_refs ?? {}) as Record<string, unknown>;
  const cwAdopted =
    (refs.camera_work_revision_ids as string[] | undefined) ?? [];
  const cwApplied =
    (refs.camera_work_applied_revision_ids as string[] | undefined) ?? [];
  const sel = (inputs.settings?.workflow_selection ?? undefined) as
    { prompt_verbatim?: boolean } | undefined;
  // same judgment as the builder: applied only on the verified H3 path
  if (cwApplied.length > 0) return "applied";
  if (cwAdopted.length === 0) return null;
  if (rec.kind !== "video") return "notAppliedKind";
  if (sel?.prompt_verbatim) return "notAppliedVerbatim";
  return "notAppliedWorkflow";
}
