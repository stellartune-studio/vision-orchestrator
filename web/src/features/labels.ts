import type { AdoptionState, ItemKind } from "@vo/shared";

export const KIND_ORDER: readonly ItemKind[] = [
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

/** English fallbacks when a translator is unavailable. UI copy uses i18n keys. */
export const KIND_LABEL: Record<ItemKind, string> = {
  purpose: "Purpose",
  intent: "Intent / impression",
  audience: "Audience",
  worldview: "Worldview",
  story_segment: "Structure",
  shot: "Shot",
  camera_work: "Camera direction",
  fixed_constraint: "Fixed constraint",
  material: "Material",
  output_policy: "Output policy",
  other: "Other",
};

export const DOC_LABEL: Record<"script" | "storyboard", string> = {
  script: "Script",
  storyboard: "Storyboard",
};

export const ADOPTION_LABEL: Record<AdoptionState, string> = {
  undecided: "Undecided",
  proposed_only: "Proposed only",
  adopted: "Adopted",
};

export function adoptionBadgeClass(a: AdoptionState): string {
  return a === "adopted" ? "adopted" : a === "undecided" ? "undecided" : "proposed";
}
