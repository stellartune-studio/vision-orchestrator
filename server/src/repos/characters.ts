import { DatabaseSync } from "node:sqlite";
import type {
  Character,
  CharacterRevision,
  CharacterSheet,
  CharacterSheetLockField,
  CharacterView,
  ProjectCharacter,
  SaveCharacterSheetResponse,
} from "@vo/shared";
import { newId } from "../domain/ids.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

export function getCharacter(db: DatabaseSync, id: string): Character {
  const row = db
    .prepare("SELECT id, name, created_at FROM characters WHERE id = ?")
    .get(id) as unknown as Character | undefined;
  if (!row) throw new NotFoundError(`character ${id}`);
  return row;
}

export function listCharacters(db: DatabaseSync): Character[] {
  return db
    .prepare("SELECT id, name, created_at FROM characters ORDER BY created_at")
    .all() as unknown as Character[];
}

export function createCharacter(
  db: DatabaseSync,
  name: string,
): Character {
  const id = newId();
  db.prepare("INSERT INTO characters (id, name) VALUES (?, ?)").run(
    id,
    name,
  );
  return getCharacter(db, id);
}

export function listCharacterRevisions(
  db: DatabaseSync,
  characterId: string,
): CharacterRevision[] {
  return db
    .prepare(
      `SELECT id, character_id, rev_no, profile, base_image_asset_id, created_at
         FROM character_revisions WHERE character_id = ? ORDER BY rev_no`,
    )
    .all(characterId) as unknown as CharacterRevision[];
}

/**
 * Append a new character revision. Setting a base image is only ever a
 * NEW revision — generated images never silently replace the approved
 * reference.
 */
export function insertCharacterRevision(
  db: DatabaseSync,
  input: {
    character_id: string;
    profile: string;
    base_image_asset_id?: string | null;
  },
): CharacterRevision {
  getCharacter(db, input.character_id);
  if (input.base_image_asset_id) {
    const asset = db
      .prepare("SELECT id FROM assets WHERE id = ?")
      .get(input.base_image_asset_id);
    if (!asset) {
      throw new BadRequestError("base image asset does not exist");
    }
  }
  const id = newId();
  db.prepare(
    `INSERT INTO character_revisions
       (id, character_id, rev_no, profile, base_image_asset_id)
     VALUES (?, ?,
       (SELECT COALESCE(MAX(rev_no), 0) + 1 FROM character_revisions
         WHERE character_id = ?),
       ?, ?)`,
  ).run(
    id,
    input.character_id,
    input.character_id,
    input.profile,
    input.base_image_asset_id ?? null,
  );
  return db
    .prepare(
      "SELECT * FROM character_revisions WHERE id = ?",
    )
    .get(id) as unknown as CharacterRevision;
}

export function getCharacterRevision(
  db: DatabaseSync,
  id: string,
): CharacterRevision {
  const row = db
    .prepare("SELECT * FROM character_revisions WHERE id = ?")
    .get(id) as unknown as CharacterRevision | undefined;
  if (!row) throw new NotFoundError(`character revision ${id}`);
  return row;
}

/** Pin a specific character revision to a project. Library updates
 * never affect this pin. */
export function pinCharacterRevision(
  db: DatabaseSync,
  input: {
    project_id: string;
    character_id: string;
    character_revision_id: string;
  },
): ProjectCharacter {
  const rev = db
    .prepare(
      "SELECT id FROM character_revisions WHERE id = ? AND character_id = ?",
    )
    .get(input.character_revision_id, input.character_id);
  if (!rev) {
    throw new BadRequestError(
      "character revision does not belong to this character",
    );
  }
  db.prepare(
    `INSERT INTO project_characters
       (project_id, character_id, character_revision_id)
     VALUES (?, ?, ?)
     ON CONFLICT (project_id, character_id)
     DO UPDATE SET character_revision_id = excluded.character_revision_id, pin_version = project_characters.pin_version + 1`,
  ).run(input.project_id, input.character_id, input.character_revision_id);
  return db
    .prepare(
      `SELECT * FROM project_characters
        WHERE project_id = ? AND character_id = ?`,
    )
    .get(input.project_id, input.character_id) as unknown as ProjectCharacter;
}

export function listProjectCharacters(
  db: DatabaseSync,
  projectId: string,
): ProjectCharacter[] {
  return db
    .prepare(
      "SELECT * FROM project_characters WHERE project_id = ?",
    )
    .all(projectId) as unknown as ProjectCharacter[];
}

export function toCharacterView(
  db: DatabaseSync,
  character: Character,
): CharacterView {
  return {
    ...character,
    revisions: listCharacterRevisions(db, character.id),
  };
}

/**
 * Save a workbench character sheet as a NEW revision and move the
 * work's pin to it — the single atomic operation behind the sheet's
 * explicit save (revision insert + pin in one transaction, run by
 * the caller via transact). Never calls an LLM or a generation
 * backend.
 *
 * - `base_revision_id` must point at a revision of this character
 *   and is required once any revision exists: the base image is
 *   carried forward, so saving a sheet never silently drops the
 *   pinned reference. An explicit `base_image_asset_id` overrides
 *   it, and must be an asset owned by this character.
 * - `expected_revision_id` must equal the work's current pin (null
 *   when unpinned) — a stale sheet is a conflict, never a silent
 *   overwrite of a newer pin.
 * - `name` beside `character_id` renames the character inside the
 *   same transaction (the name is entity-level, not revisioned).
 */
export function saveCharacterSheet(
  db: DatabaseSync,
  input: {
    project_id: string;
    character_id?: string;
    name?: string;
    sheet: CharacterSheet;
    base_revision_id?: string;
    base_image_asset_id?: string;
    expected_revision_id: string | null;
  },
): SaveCharacterSheetResponse {
  let character = input.character_id
    ? getCharacter(db, input.character_id)
    : createCharacter(db, input.name!);

  // `name` alongside character_id renames inside the same save —
  // the name is entity-level (not revisioned), so an explicit save
  // is still the only write path.
  if (input.character_id && input.name && input.name !== character.name) {
    db.prepare("UPDATE characters SET name = ? WHERE id = ?").run(
      input.name,
      character.id,
    );
    character = getCharacter(db, character.id);
  }

  const revisions = listCharacterRevisions(db, character.id);
  let baseImage: string | null = null;
  if (revisions.length > 0) {
    if (!input.base_revision_id) {
      throw new BadRequestError(
        "base_revision_id is required once a character has revisions",
      );
    }
    const base = revisions.find((r) => r.id === input.base_revision_id);
    if (!base) {
      throw new BadRequestError(
        "base revision does not belong to this character",
      );
    }
    baseImage = base.base_image_asset_id;
  } else if (input.base_revision_id) {
    throw new BadRequestError(
      "this character has no revisions to base on",
    );
  }

  // An explicit base image overrides the carried-forward one. It must
  // be an asset owned by THIS character — cross-owner references are
  // rejected rather than silently aliased.
  if (input.base_image_asset_id !== undefined) {
    const asset = db
      .prepare("SELECT owner_kind, owner_id FROM assets WHERE id = ?")
      .get(input.base_image_asset_id) as
      | { owner_kind: string; owner_id: string }
      | undefined;
    if (
      !asset ||
      asset.owner_kind !== "character" ||
      asset.owner_id !== character.id
    ) {
      throw new BadRequestError(
        "base image must be an asset owned by this character",
      );
    }
    baseImage = input.base_image_asset_id;
  }

  const pinRow = db
    .prepare(
      `SELECT character_revision_id FROM project_characters
        WHERE project_id = ? AND character_id = ?`,
    )
    .get(input.project_id, character.id) as
    | { character_revision_id: string }
    | undefined;
  if ((pinRow?.character_revision_id ?? null) !== input.expected_revision_id) {
    throw new ConflictError(
      "the character version pinned to this work changed; reload before saving",
    );
  }

  // The sheet is the canonical payload. Only fields the user
  // explicitly locked are mirrored into traits.locked (the consult
  // context reads those) — text alone never locks, and clearing the
  // text or the lock drops the trait on the next save.
  const FIELD_TO_TRAIT: Record<CharacterSheetLockField, string> = {
    outfit: "outfit",
    traits: "features",
    colors: "colors",
    expression_memo: "expression",
  };
  const locked: Record<string, string> = {};
  for (const f of input.sheet.locked_fields) {
    const v = input.sheet[f];
    if (v) locked[FIELD_TO_TRAIT[f]] = v;
  }
  // persona/appearance are lifted to the profile top level — the
  // generation input builder and consult context read them there.
  const revision = insertCharacterRevision(db, {
    character_id: character.id,
    profile: JSON.stringify({
      ...(input.sheet.persona ? { persona: input.sheet.persona } : {}),
      ...(input.sheet.appearance
        ? { appearance: input.sheet.appearance }
        : {}),
      traits: { locked },
      sheet: input.sheet,
    }),
    base_image_asset_id: baseImage,
  });
  const pin = pinCharacterRevision(db, {
    project_id: input.project_id,
    character_id: character.id,
    character_revision_id: revision.id,
  });
  return { character: toCharacterView(db, character), revision, pin };
}

/** Public pin selection uses the same transaction as its optimistic check. */
export function saveCharacterPin(db: DatabaseSync, input: { project_id: string; character_id: string; character_revision_id: string; expected_version: number | null }): ProjectCharacter {
  const current = db.prepare("SELECT pin_version FROM project_characters WHERE project_id = ? AND character_id = ?").get(input.project_id, input.character_id) as { pin_version: number } | undefined;
  if ((current?.pin_version ?? null) !== input.expected_version) throw new ConflictError("Character pin changed; fetch and compare the latest state before choosing again");
  return pinCharacterRevision(db, input);
}
