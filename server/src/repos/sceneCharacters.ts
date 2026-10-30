import type { DatabaseSync } from "node:sqlite";
import { getItem, insertRevision } from "./items.ts";
import { BadRequestError, ConflictError } from "./errors.ts";

export interface SceneCharacter {
  character_id: string;
  character_revision_id: string;
  name: string;
}

export function sceneCharacters(db: DatabaseSync, revisionId: string): SceneCharacter[] {
  return db.prepare(`SELECT sc.character_id, sc.character_revision_id, sc.name
    FROM scene_revision_characters sc
    WHERE sc.revision_id = ? ORDER BY sc.character_id`).all(revisionId) as unknown as SceneCharacter[];
}

/** Caller provides a transaction; changes are a new scene proposal, never an adoption. */
export function proposeSceneCharacters(db: DatabaseSync, input: {
  project_id: string; scene_id: string; expected_version: number;
  characters: { character_id: string; character_revision_id: string; pin_version: number }[];
}) {
  const scene = getItem(db, input.scene_id);
  if (scene.project_id !== input.project_id || scene.kind !== "story_segment") throw new BadRequestError("Scene does not belong to this project");
  if (scene.state_version !== input.expected_version) throw new ConflictError("Scene changed; reload before assigning characters");
  if (!scene.adopted_revision_id) throw new ConflictError("Adopt a scene before assigning characters");
  if (new Set(input.characters.map((c) => c.character_id)).size !== input.characters.length) throw new BadRequestError("Duplicate character assignment");
  for (const character of input.characters) {
    const pin = db.prepare("SELECT character_revision_id, pin_version FROM project_characters WHERE project_id = ? AND character_id = ?").get(input.project_id, character.character_id) as { character_revision_id: string; pin_version: number } | undefined;
    if (!pin || pin.character_revision_id !== character.character_revision_id || pin.pin_version !== character.pin_version) throw new ConflictError("Character pin changed; reload before assigning characters");
  }
  const base = db.prepare("SELECT content FROM item_revisions WHERE id = ? AND item_id = ?").get(scene.adopted_revision_id, scene.id) as { content: string };
  const revision = insertRevision(db, { item_id: scene.id, content: base.content, source: "user", base_state_version: scene.state_version, inherit_scene_characters: false });
  db.prepare("INSERT INTO scene_character_proposals (revision_id) VALUES (?)").run(revision.id);
  const insert = db.prepare("INSERT INTO scene_revision_characters (revision_id, character_id, character_revision_id, name) SELECT ?, id, ?, name FROM characters WHERE id = ?");
  for (const character of input.characters) insert.run(revision.id, character.character_revision_id, character.character_id);
  return revision;
}

export function pendingSceneCharacterProposals(db: DatabaseSync, sceneId: string): { revision_id: string; content: string; characters: SceneCharacter[] }[] {
  const rows = db.prepare(`SELECT r.id, r.content FROM item_revisions r JOIN scene_character_proposals p ON p.revision_id = r.id
    WHERE r.item_id = ? AND r.proposal_status = 'pending' ORDER BY r.rev_no`).all(sceneId) as { id: string; content: string }[];
  return rows.map((row) => ({ revision_id: row.id, content: row.content, characters: sceneCharacters(db, row.id) }));
}

/** Snapshot creation must not silently substitute a newer project character pin. */
export function assertSceneCharacterPins(db: DatabaseSync, projectId: string): void {
  const mismatch = db.prepare(`SELECT sc.character_id FROM design_items i
    JOIN scene_revision_characters sc ON sc.revision_id = i.adopted_revision_id
    LEFT JOIN project_characters pc ON pc.project_id = i.project_id AND pc.character_id = sc.character_id
    WHERE i.project_id = ? AND i.kind = 'story_segment'
      AND (pc.character_revision_id IS NULL OR pc.character_revision_id <> sc.character_revision_id) LIMIT 1`).get(projectId);
  if (mismatch) throw new ConflictError("A scene's character pin changed; update and adopt the scene assignment before freezing");
}
