import type { DatabaseSync } from "node:sqlite";
import { findAsset } from "../repos/assets.ts";
import { getCharacterRevision } from "../repos/characters.ts";
import { sceneCharacters } from "../repos/sceneCharacters.ts";
import { UnprocessableError } from "../repos/errors.ts";
import { verifiedPromotionAsset } from "./promotionAsset.ts";

/** Verify project ownership or a base image of a character pinned to this scene. */
export function verifySceneEditSource(db: DatabaseSync, input: { projectId: string; sceneRevisionId: string; assetId: string; root: string; maxBytes: number }) {
  const asset = findAsset(db, input.assetId);
  if (!asset) throw new UnprocessableError("Edit source asset not found");
  const projectOwned = asset.owner_kind === "project" && asset.owner_id === input.projectId && !!asset.selected;
  const characterOwned = sceneCharacters(db, input.sceneRevisionId).some((cast) => {
    const revision = getCharacterRevision(db, cast.character_revision_id);
    return revision.character_id === cast.character_id && revision.base_image_asset_id === asset.id && asset.owner_kind === "character" && asset.owner_id === cast.character_id;
  });
  if (!projectOwned && !characterOwned) throw new UnprocessableError("Edit source must be a selected project image or this scene's pinned character base image");
  const bytes = verifiedPromotionAsset({ ...asset, owner_kind: "project", owner_id: input.projectId }, input.projectId, input.root, input.maxBytes, "image/png");
  return { asset, bytes, characterOwned };
}
