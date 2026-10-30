import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Chrome styling must go through the design tokens declared in
// styles.css :root (plus the preset ramps in theme.tsx). Literal
// colors remain only inside token definitions, animation keyframes,
// and the artwork/preview selectors below — those depict scenes and
// characters, not themeable UI surfaces.
const ART_SELECTORS = [
  "avatar",
  "scene-art",
  "template-art",
  "sample-art",
  "sample-variants",
  "sample-toggle",
  "point-preview",
  "variant-art",
  "lane-beats",
  "video-edit-panel video",
];

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const CSS_FILES = [
  join(SRC, "styles.css"),
  ...readdirSync(join(SRC, "features"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(SRC, "features", f)),
];

const RULE = /([^{}]+)\{([^{}]*)\}/g;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const PX_FONT_SIZE = /font-size:\s*[0-9.]+px/;

test("literal colors stay inside token definitions and artwork selectors", () => {
  const offenders: string[] = [];
  for (const file of CSS_FILES) {
    for (const m of readFileSync(file, "utf8").matchAll(RULE)) {
      if (!HEX.test(m[2])) continue;
      const selector = m[1].trim();
      // @-rule headers never match this pattern (their bodies contain
      // braces), so nested rules are matched individually and judged by
      // the same allowlist.
      if (selector.includes(":root")) continue;
      if (ART_SELECTORS.some((s) => selector.includes(s))) continue;
      offenders.push(`${file}: ${selector.replace(/\s+/g, " ").slice(-90)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("font sizes come from the --fs-* ramp, not raw px literals", () => {
  const offenders: string[] = [];
  for (const file of CSS_FILES) {
    for (const m of readFileSync(file, "utf8").matchAll(RULE)) {
      if (!PX_FONT_SIZE.test(m[2])) continue;
      const selector = m[1].trim();
      if (selector.includes(":root")) continue;
      offenders.push(`${file}: ${selector.replace(/\s+/g, " ").slice(-90)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
