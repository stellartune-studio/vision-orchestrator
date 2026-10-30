import type { ItemView } from "@vo/shared";

/** Existing ordered scene items remain owned by the project's blueprint. */
export function storyScenes(items: ItemView[]): ItemView[] {
  return items.filter((item) => item.kind === "story_segment")
    .sort((a, b) => a.seq - b.seq);
}
