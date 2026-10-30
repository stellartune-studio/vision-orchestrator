import type { DatabaseSync } from "node:sqlite";

export interface SceneEditSource { revision_id: string; asset_id: string; sha256: string }

export function sceneEditSource(db: DatabaseSync, revisionId: string): SceneEditSource | undefined {
  return db.prepare("SELECT revision_id, asset_id, sha256 FROM scene_edit_sources WHERE revision_id = ?").get(revisionId) as unknown as SceneEditSource | undefined;
}

export function insertSceneEditSource(db: DatabaseSync, source: SceneEditSource): void {
  db.prepare("INSERT INTO scene_edit_sources (revision_id, asset_id, sha256) VALUES (?, ?, ?)").run(source.revision_id, source.asset_id, source.sha256);
}
