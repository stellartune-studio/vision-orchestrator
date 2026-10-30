/**
 * Accepted document format for a single scene (the ONLY format the
 * draft validates — this is format checking, not a claim that any
 * natural-language document provably contains one scene):
 *
 *   - one scene heading line:
 *       場面[:：] / 場面N[:：] / シーンN[:：]
 *       Scene[:] / Scene N[:] / Scene N -   (ASCII; case-insensitive)
 *     (line-leading; inline mentions do not count)
 *   - the heading must be the first non-empty line
 *   - text after the heading (same line and/or following lines)
 *     must be non-empty
 *   - no other scene-like heading may appear — supported or not
 *     (e.g. a numberless シーン heading mixed in)
 */
const SUPPORTED_SCENE_HEADING =
  /^\s*(?:場面\s*\d*\s*[:：]|シーン\s*\d+\s*[:：]|Scene\s*\d*\s*(?:[:：]|-\s))/i;
/** A line that LOOKS like a scene heading but is not in the accepted
 *  format — its presence means the document uses designations the
 *  draft cannot reconcile (mixed formats → target selection). */
const SCENE_HEADINGISH =
  /^\s*(?:場面|シーン|Scene)[^\n:：\-]{0,20}(?:[:：]|-\s)/i;
/** Marker text ANYWHERE — used only to distinguish "designation
 *  mentioned inline" from "no designation at all" in the reason. */
const INLINE_SCENE_MARKER =
  /場面\s*\d*\s*[:：]|シーン\s*\d+\s*[:：]|Scene\s*\d*\s*(?:[:：]|-\s)/i;
const SCENE_FORMAT_HINT =
  "Accepted form: a leading heading such as \"Scene:\", \"Scene 1:\", " +
  "\"Scene 1 -\", \"場面:\", \"場面1:\", or \"シーン1:\" " +
  "(scene (+ optional number) + colon or dash), followed by non-empty body text.";

/**
 * Validate the document's scene designation against the accepted
 * format. Pure format check — exported for direct regression tests.
 */
export function parseSceneDesignation(
  content: string,
): { ok: true } | { ok: false; reason: string } {
  const lines = content.split("\n");
  const supported: number[] = [];
  let headingish = 0;
  lines.forEach((l, i) => {
    if (SUPPORTED_SCENE_HEADING.test(l)) supported.push(i);
    else if (SCENE_HEADINGISH.test(l)) headingish++;
  });
  if (supported.length === 0) {
    if (headingish > 0) {
      return {
        ok: false,
        reason:
          "Scene heading is not in an accepted form — " +
          "the scene cannot be identified, so an explicit target is required. " +
          SCENE_FORMAT_HINT,
      };
    }
    if (INLINE_SCENE_MARKER.test(content)) {
      return {
        ok: false,
        reason:
          "Scene designation appears only as an inline mention — " +
          "it is not treated as a line-leading heading. " + SCENE_FORMAT_HINT,
      };
    }
    return {
      ok: false,
      reason:
        "No identifying scene designation was found — " +
        "a single scene is not assumed; an explicit target is required. " +
        SCENE_FORMAT_HINT,
    };
  }
  if (supported.length > 1) {
    return {
      ok: false,
      reason:
        `${supported.length} accepted scene headings were found — ` +
        "target selection is required (the first scene is not chosen automatically).",
    };
  }
  if (headingish > 0) {
    return {
      ok: false,
      reason:
        "Accepted and unsupported scene headings are mixed — " +
        "target selection is required. " + SCENE_FORMAT_HINT,
    };
  }
  const h = supported[0];
  const firstNonEmpty = lines.findIndex((l) => l.trim());
  if (h !== firstNonEmpty) {
    return {
      ok: false,
      reason:
        "Scene heading is not at the start of the document — " +
        "text before the heading cannot be related to the scene, so " +
        "an explicit target is required. " + SCENE_FORMAT_HINT,
    };
  }
  const after = lines[h].replace(SUPPORTED_SCENE_HEADING, "").trim();
  const rest = lines.slice(h + 1).join("\n").trim();
  if (!after && !rest) {
    return {
      ok: false,
      reason:
        "Scene heading has no body text — " +
        "an empty designation cannot be accepted as a scene. " + SCENE_FORMAT_HINT,
    };
  }
  return { ok: true };
}