import type { CharacterSheet, CharacterSheetLockField, CharacterSheetView } from "@vo/shared";
import { CHARACTER_SHEET_LOCKABLE_FIELDS, CHARACTER_SHEET_VIEWS } from "@vo/shared";
import { BadRequestError } from "../repos/errors.ts";

const SHEET_TEXT_FIELDS = [
  "persona",
  "appearance",
  "outfit",
  "traits",
  "colors",
  "expression_memo",
] as const;

/** Strict request-body → CharacterSheet validation. Unknown fields,
 *  non-string values and unlisted view names are rejected — the
 *  stored profile shape is fixed here, not trusted from the wire. */
export function parseCharacterSheet(v: unknown): CharacterSheet {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new BadRequestError("sheet must be an object");
  }
  const o = v as Record<string, unknown>;
  const allowed = new Set<string>([
    ...SHEET_TEXT_FIELDS,
    "placed_views",
    "locked_fields",
  ]);
  if (Object.keys(o).some((k) => !allowed.has(k))) {
    throw new BadRequestError("sheet contains an unknown field");
  }
  const text = (key: (typeof SHEET_TEXT_FIELDS)[number]): string => {
    const val = o[key];
    if (val === undefined) return "";
    if (typeof val !== "string") {
      throw new BadRequestError(`sheet.${key} must be a string`);
    }
    return val;
  };
  const rawViews = o.placed_views;
  if (rawViews !== undefined && !Array.isArray(rawViews)) {
    throw new BadRequestError("sheet.placed_views must be an array");
  }
  const placed: CharacterSheetView[] = [];
  for (const v2 of rawViews ?? []) {
    if (
      typeof v2 !== "string" ||
      !(CHARACTER_SHEET_VIEWS as readonly string[]).includes(v2)
    ) {
      throw new BadRequestError("sheet.placed_views contains an unknown view");
    }
    if (!placed.includes(v2 as CharacterSheetView)) {
      placed.push(v2 as CharacterSheetView);
    }
  }
  const rawLocked = o.locked_fields;
  if (rawLocked !== undefined && !Array.isArray(rawLocked)) {
    throw new BadRequestError("sheet.locked_fields must be an array");
  }
  const lockedFields: CharacterSheetLockField[] = [];
  for (const v2 of rawLocked ?? []) {
    if (
      typeof v2 !== "string" ||
      !(CHARACTER_SHEET_LOCKABLE_FIELDS as readonly string[]).includes(v2)
    ) {
      throw new BadRequestError(
        "sheet.locked_fields contains an unknown field",
      );
    }
    if (!lockedFields.includes(v2 as CharacterSheetLockField)) {
      lockedFields.push(v2 as CharacterSheetLockField);
    }
  }
  return {
    persona: text("persona"),
    appearance: text("appearance"),
    outfit: text("outfit"),
    traits: text("traits"),
    colors: text("colors"),
    expression_memo: text("expression_memo"),
    placed_views: placed,
    locked_fields: lockedFields,
  };
}
