import type { BlueprintVersionDetail, ProjectState } from "@vo/shared";

/** Only the frozen blueprint, not live selections, decides the reference. */
export function hasFrozenImageReference(detail: BlueprintVersionDetail | null, assets: ProjectState["assets"]): boolean {
  return !!detail && (detail.characters.some((entry) => !!entry.base_image_asset_id) || detail.assets.some((entry) => assets.some((asset) => asset.id === entry.asset_id && asset.mime?.startsWith("image/"))));
}
