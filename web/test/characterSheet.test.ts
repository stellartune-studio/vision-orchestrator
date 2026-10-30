import test from "node:test";
import assert from "node:assert/strict";
import type { CharacterRevision, CharacterView } from "@vo/shared";
import {
  displayRevision,
  emptySheet,
  sheetFromRevision,
  sheetsEqual,
} from "../src/features/characterSheet.ts";

function rev(
  id: string,
  revNo: number,
  profile: unknown,
  baseImage: string | null = null,
): CharacterRevision {
  return {
    id,
    character_id: "c1",
    rev_no: revNo,
    profile: typeof profile === "string" ? profile : JSON.stringify(profile),
    base_image_asset_id: baseImage,
    created_at: "2026-10-20",
  };
}

const SHEET = {
  persona: "quiet apprentice mage",
  appearance: "short silver hair, round glasses",
  outfit: "navy coat",
  traits: "silver pin",
  colors: "navy / white",
  expression_memo: "calm",
  placed_views: ["front", "side"],
  locked_fields: ["outfit", "colors"],
};

test("sheetFromRevision: reads the stored sheet verbatim", () => {
  const r = rev("r1", 1, { traits: { locked: {} }, sheet: SHEET });
  assert.deepEqual(sheetFromRevision(r), SHEET);
});

test("sheetFromRevision: missing sheet key or malformed JSON → empty sheet", () => {
  assert.deepEqual(sheetFromRevision(null), emptySheet());
  assert.deepEqual(sheetFromRevision(undefined), emptySheet());
  assert.deepEqual(
    sheetFromRevision(rev("r1", 1, "not json {")),
    emptySheet(),
  );
});

test("sheetFromRevision: legacy top-level persona/appearance fall back, sheet wins", () => {
  // pre-sheet revisions stored persona/appearance at the profile top
  // level — they load into the sheet so a re-save never drops them
  assert.deepEqual(sheetFromRevision(rev("r1", 1, { persona: "p", appearance: "a" })), {
    ...emptySheet(),
    persona: "p",
    appearance: "a",
  });
  const s = sheetFromRevision(
    rev("r1", 1, { persona: "old", sheet: { persona: "new" } }),
  );
  assert.equal(s.persona, "new");
  assert.equal(s.appearance, "");
});

test("sheetFromRevision: unknown placed views are dropped, fields coerced", () => {
  const r = rev("r1", 1, {
    sheet: { outfit: "a", placed_views: ["front", "ceiling", 3] },
  });
  const s = sheetFromRevision(r);
  assert.equal(s.outfit, "a");
  assert.deepEqual(s.placed_views, ["front"]);
  assert.equal(s.traits, "");
  assert.deepEqual(s.locked_fields, []);
});

test("sheetFromRevision: locked_fields round-trips, unknown keys dropped", () => {
  const r = rev("r1", 1, {
    sheet: {
      ...SHEET,
      locked_fields: ["outfit", "password", 7],
    },
  });
  assert.deepEqual(sheetFromRevision(r).locked_fields, ["outfit"]);
});

test("sheetsEqual: field-by-field including placed_views and locked_fields order", () => {
  assert.ok(sheetsEqual(SHEET, { ...SHEET }));
  assert.ok(!sheetsEqual(SHEET, { ...SHEET, persona: "x" }));
  assert.ok(!sheetsEqual(SHEET, { ...SHEET, appearance: "x" }));
  assert.ok(!sheetsEqual(SHEET, { ...SHEET, outfit: "x" }));
  assert.ok(
    !sheetsEqual(SHEET, { ...SHEET, placed_views: ["side", "front"] }),
  );
  assert.ok(!sheetsEqual(SHEET, { ...SHEET, placed_views: ["front"] }));
  // fixing/unfixing is a real change — the draft stays dirty
  assert.ok(!sheetsEqual(SHEET, { ...SHEET, locked_fields: ["outfit"] }));
  assert.ok(
    !sheetsEqual(SHEET, { ...SHEET, locked_fields: ["colors", "outfit"] }),
  );
});

test("displayRevision: pinned revision wins over the latest", () => {
  const r1 = rev("r1", 1, {});
  const r2 = rev("r2", 2, {});
  const view: CharacterView = {
    id: "c1",
    name: "c",
    created_at: "2026-10-20",
    revisions: [r1, r2],
  };
  assert.equal(displayRevision(view, "r1")?.id, "r1");
  assert.equal(displayRevision(view, null)?.id, "r2");
  // pinned-but-missing falls back to latest rather than nothing
  assert.equal(displayRevision(view, "gone")?.id, "r2");
  assert.equal(
    displayRevision({ ...view, revisions: [] }, null),
    null,
  );
});
