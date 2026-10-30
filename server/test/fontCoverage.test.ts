import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { missingFontCodepoints, requireFontCoverage } from "../src/gen/fontCoverage.ts";

function fixtureFont(): Buffer {
  const font = Buffer.alloc(84);
  font.writeUInt32BE(0x00010000, 0); font.writeUInt16BE(1, 4);
  font.write("cmap", 12, "ascii"); font.writeUInt32BE(28, 20); font.writeUInt32BE(56, 24);
  font.writeUInt16BE(1, 30); font.writeUInt16BE(3, 32); font.writeUInt16BE(10, 34); font.writeUInt32BE(12, 36);
  font.writeUInt16BE(12, 40); font.writeUInt32BE(40, 44); font.writeUInt32BE(2, 52);
  font.writeUInt32BE(0x41, 56); font.writeUInt32BE(0x5a, 60); font.writeUInt32BE(1, 64);
  font.writeUInt32BE(0x1f600, 68); font.writeUInt32BE(0x1f600, 72); font.writeUInt32BE(27, 76);
  return font;
}
test("font coverage accepts mapped codepoints and rejects missing or unverified sequences", () => {
  const font = fixtureFont();
  assert.deepEqual(missingFontCodepoints(font, "AZ😀\n"), []);
  assert.deepEqual(missingFontCodepoints(font, "Aあ"), [0x3042]);
  assert.throws(() => requireFontCoverage(font, "Aあ"), /U\+3042/);
  assert.throws(() => requireFontCoverage(font, "A\uFE0F"), /U\+FE0F/);
  assert.throws(() => missingFontCodepoints(Buffer.alloc(4), "A"), /coverage could not be verified/);
});
test("installed Japanese font covers a Japanese sample but rejects an absent supplementary glyph", { skip: !existsSync("C:\\Windows\\Fonts\\msgothic.ttc") }, () => {
  const font = readFileSync("C:\\Windows\\Fonts\\msgothic.ttc");
  assert.deepEqual(missingFontCodepoints(font, "月の灯り"), []);
  assert.ok(missingFontCodepoints(font, "\u{1F9D1}").length > 0);
});
