import test from "node:test";
import assert from "node:assert/strict";
import { BadRequestError } from "../src/repos/errors.ts";
import { parseCharacterSheet } from "../src/http/characterSheetBody.ts";

test("character sheet body parser applies defaults and stable de-duplication", () => {
  assert.deepEqual(
    parseCharacterSheet({
      outfit: "  navy coat  ",
      placed_views: ["front", "expressions", "front"],
      locked_fields: ["outfit", "colors", "outfit"],
    }),
    {
      persona: "",
      appearance: "",
      outfit: "  navy coat  ",
      traits: "",
      colors: "",
      expression_memo: "",
      placed_views: ["front", "expressions"],
      locked_fields: ["outfit", "colors"],
    },
  );
});

test("character sheet body parser preserves BadRequestError for invalid shapes", () => {
  const invalid: Array<[unknown, string]> = [
    [null, "sheet must be an object"],
    [[], "sheet must be an object"],
    [{ extra: true }, "sheet contains an unknown field"],
    [{ outfit: 42 }, "sheet.outfit must be a string"],
    [{ placed_views: "front" }, "sheet.placed_views must be an array"],
    [
      { placed_views: ["ceiling"] },
      "sheet.placed_views contains an unknown view",
    ],
    [{ locked_fields: false }, "sheet.locked_fields must be an array"],
    [
      { locked_fields: ["password"] },
      "sheet.locked_fields contains an unknown field",
    ],
    // persona/appearance are editable but never lockable
    [
      { locked_fields: ["persona"] },
      "sheet.locked_fields contains an unknown field",
    ],
    [
      { locked_fields: ["appearance"] },
      "sheet.locked_fields contains an unknown field",
    ],
  ];

  for (const [body, message] of invalid) {
    assert.throws(
      () => parseCharacterSheet(body),
      (error) => {
        assert.ok(error instanceof BadRequestError);
        assert.equal(error.message, message);
        return true;
      },
    );
  }
});
