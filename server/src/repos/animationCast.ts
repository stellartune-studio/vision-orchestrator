import type { DatabaseSync } from "node:sqlite";
import { ConflictError } from "./errors.ts";

/** Call in the transaction that creates the shot revision. */
export function insertAnimationCast(db: DatabaseSync, revisionId: string, characterId: string, characterRevisionId: string): void {
  db.prepare("INSERT INTO animation_shot_cast (revision_id, character_id, character_revision_id) VALUES (?, ?, ?)").run(revisionId, characterId, characterRevisionId);
}

/** Never silently replace a shot's selected character revision during freeze. */
export function assertAnimationPins(db: DatabaseSync, projectId: string): void {
  const mismatch = db.prepare(`SELECT c.character_id FROM design_items i
    JOIN animation_shot_cast c ON c.revision_id = i.adopted_revision_id
    LEFT JOIN project_characters p ON p.project_id = i.project_id AND p.character_id = c.character_id
    WHERE i.project_id = ? AND i.kind = 'shot'
      AND (p.character_revision_id IS NULL OR p.character_revision_id <> c.character_revision_id) LIMIT 1`).get(projectId);
  if (mismatch) throw new ConflictError("An animation shot's character pin changed; create and adopt an updated shot before freezing");
}
