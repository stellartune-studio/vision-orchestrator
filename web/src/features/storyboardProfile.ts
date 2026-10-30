import type { SavedWorkflowSelection, ServerMeta } from "@vo/shared";

/** A selected custom graph overrides the server's bundled profile. */
export function storyboardUsesSingleEdit(meta: ServerMeta | null, workflow: SavedWorkflowSelection | null): boolean {
  return !!workflow && !workflow.selection && meta?.gen_profile === "qwen-image-2.1-turbo-edit-single";
}
