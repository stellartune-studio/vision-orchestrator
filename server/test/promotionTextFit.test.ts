import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPromotionText, wrapPromotionText } from "../src/gen/promotionTextFit.ts";

test("title fitting selects the largest fitting size and fails closed", async () => {
  const measure = async (size: number) => ({ width: size * 4, height: size * 2, clipped: false });
  assert.equal(await fitPromotionText({ width: 100, height: 100 }, 40, measure), 25);
  await assert.rejects(fitPromotionText({ width: 20, height: 20 }, 40, measure), /minimum font size/);
  await assert.rejects(fitPromotionText({ width: 100, height: 100 }, 40, async () => ({ width: 0, height: 0, clipped: false })), /measure/);
  await assert.rejects(fitPromotionText({ width: 10000, height: 10000 }, 40, async () => ({ width: 100, height: 10, clipped: true })), /minimum font size/);
});

test("wrap respects grapheme boundaries, explicit lines and Japanese punctuation", async () => {
  const measure = async (line: string) => Array.from(new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(line)).length;
  const wrapped = await wrapPromotionText("月の灯り、森を照らす。\n静かな夜", 5, measure);
  assert.equal(wrapped.replaceAll("\n", ""), "月の灯り、森を照らす。静かな夜");
  for (const line of wrapped.split("\n")) { assert.ok(await measure(line) <= 5); assert.doesNotMatch(line, /^[、。]/u); assert.doesNotMatch(line, /[「（]$/u); }
  assert.equal(await wrapPromotionText("A😀B", 2, measure), "A😀\nB");
  await assert.rejects(wrapPromotionText("（あ", 1, measure), /invalid line break/);
});
