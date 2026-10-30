import assert from "node:assert/strict";
import { test } from "node:test";
import { promotionComposeArgs, validatePromotionLayout } from "../src/gen/promotionCompose.ts";

test("promotion layout is bounded and produces a fixed-name, non-expanding filter", () => {
  const layout = { logo: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, title: { x: 0.1, y: 0.8, width: 0.8, height: 0.1 } };
  assert.deepEqual(validatePromotionLayout(layout), layout);
  const args = promotionComposeArgs(layout, 24, { width: 768, height: 1344 });
  assert.match(args[args.indexOf("-filter_complex") + 1], /textfile=title\.txt:expansion=none/);
  assert.match(args[args.indexOf("-filter_complex") + 1], /scale=w=153:h=268/);
  const multiline = promotionComposeArgs(layout, 24, { width: 768, height: 1344 }, 2);
  const filter = multiline[multiline.indexOf("-filter_complex") + 1];
  assert.match(filter, /textfile=title-line-0\.txt/);
  assert.match(filter, /textfile=title-line-1\.txt/);
  assert.ok(args.includes("source.mp4") && args.includes("logo.png"));
  assert.throws(() => validatePromotionLayout({ ...layout, logo: { ...layout.logo, x: 0.9 } }));
  assert.throws(() => validatePromotionLayout({ ...layout, title: { ...layout.title, y: Infinity } }));
  assert.throws(() => validatePromotionLayout({ ...layout, command: "unexpected" }));
});
