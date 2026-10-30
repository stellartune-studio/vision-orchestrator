import assert from "node:assert/strict";
import { test } from "node:test";
import { validPromotionLayout } from "../src/features/promotionLayout.ts";

test("promotion placement prevents invalid or out-of-frame rectangles", () => {
  const layout = { logo: { x: .1, y: .1, width: .2, height: .2 }, title: { x: .1, y: .8, width: .8, height: .1 } };
  assert.equal(validPromotionLayout(layout), true);
  assert.equal(validPromotionLayout({ ...layout, logo: { ...layout.logo, x: .9 } }), false);
  assert.equal(validPromotionLayout({ ...layout, title: { ...layout.title, height: NaN } }), false);
  assert.equal(validPromotionLayout({ ...layout, title: { ...layout.title, width: 0 } }), false);
});
