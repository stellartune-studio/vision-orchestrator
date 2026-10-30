import type { ItemKind } from "@vo/shared";

/**
 * Code-defined seeding templates (v1). A project starts with the
 * `common` items visible-but-undecided BEFORE they appear in
 * conversation. Adopting a purpose revision applies the matching
 * purpose template, adding missing items as undecided.
 *
 * 起承転結 is deliberately not forced: `narrative` seeds generic
 * "story flow" segments the user can rename or repurpose.
 */

export interface ItemSeed {
  kind: ItemKind;
  label: string;
  seq?: number;
}

export interface ProjectTemplate {
  key: string;
  version: number;
  /** item kinds that must be adopted before production generation */
  required_kinds: ItemKind[];
  items: ItemSeed[];
}

/** Seeded for EVERY project at creation. */
export const COMMON_SEED: ItemSeed[] = [
  { kind: "purpose", label: "Purpose" },
  { kind: "audience", label: "Audience" },
  { kind: "intent", label: "Intent & lasting impression" },
  { kind: "fixed_constraint", label: "Fixed constraints" },
  { kind: "material", label: "Materials" },
  { kind: "output_policy", label: "Output policy (duration, aspect, destination)" },
  { kind: "camera_work", label: "Camera direction (optional)" },
];

export const TEMPLATES: Record<string, ProjectTemplate> = {
  narrative: {
    key: "narrative",
    version: 1,
    required_kinds: ["intent", "output_policy"],
    items: [
      { kind: "worldview", label: "World & tone" },
      { kind: "story_segment", label: "Story beat 1", seq: 1 },
      { kind: "story_segment", label: "Story beat 2", seq: 2 },
      { kind: "story_segment", label: "Story beat 3", seq: 3 },
    ],
  },
  introduction: {
    key: "introduction",
    version: 1,
    required_kinds: ["intent", "output_policy"],
    items: [
      { kind: "other", label: "What to introduce" },
      { kind: "story_segment", label: "Explanation step 1", seq: 1 },
      { kind: "story_segment", label: "Explanation step 2", seq: 2 },
    ],
  },
  personal: {
    key: "personal",
    version: 1,
    required_kinds: ["intent", "output_policy"],
    items: [{ kind: "worldview", label: "World & mood" }],
  },
};

/**
 * Map adopted purpose content to a template key. LLM proposals may
 * carry an explicit `template_key`; this keyword fallback covers
 * free-text user answers.
 */
export function templateKeyForPurpose(content: string): string | null {
  const c = content.toLowerCase();
  if (/(物語|ストーリー|story|narrative|drama|冒険|映画)/.test(c)) {
    return "narrative";
  }
  if (/(紹介|説明|紹介動画|intro|explain|解説|チュートリアル)/.test(c)) {
    return "introduction";
  }
  if (/(自分|個人|personal|楽しむ|趣味)/.test(c)) {
    return "personal";
  }
  return null;
}

/** Kinds whose items form an ordered sequence (story flow). */
export const ORDERED_KINDS: readonly ItemKind[] = [
  "story_segment",
  "shot",
];
