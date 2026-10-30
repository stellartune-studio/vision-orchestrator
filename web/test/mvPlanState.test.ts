import assert from "node:assert/strict";
import { test } from "node:test";
import { createMvRequestLock, mvFont, mvLines, mvReadiness, mvSignature } from "../src/features/mvPlanState.ts";

const lines = [{ start: "0", end: "2", text: "Hello" }];
const cuts = [{ start: "0", video_asset_id: "clip" }];
const base = { hasScript: true, hasBlueprint: true, audioCount: 1, videoCount: 1, adopted: true, changed: false, hasVideo: true, instrumental: true, hasFont: false, busy: false };

test("instrumental payload omits lyrics and font; switching back preserves draft", () => {
  assert.deepEqual(mvLines(true, lines), []); assert.deepEqual(mvFont(true, "font"), {});
  assert.deepEqual(mvLines(false, lines), [{ start: 0, end: 2, text: "Hello" }]);
  assert.deepEqual(mvFont(false, "configured"), { font_id: "configured" });
  assert.equal(mvReadiness(base).canRender, true);
  const lyrics = mvReadiness({ ...base, instrumental: false });
  assert.equal(lyrics.missingFont, true); assert.equal(lyrics.canRender, false);
  assert.equal(mvReadiness({ ...base, instrumental: false, hasFont: true }).canRender, true);
});
test("adoption, stale edits and unavailable frozen assets block or explain progress", () => {
  assert.equal(mvReadiness({ ...base, adopted: false }).plan, "pending");
  assert.equal(mvReadiness({ ...base, adopted: false }).canRender, false);
  assert.equal(mvReadiness({ ...base, changed: true }).plan, "stale");
  assert.equal(mvReadiness({ ...base, changed: true }).canRender, false);
  const missing = mvReadiness({ ...base, audioCount: 0, videoCount: 0, hasVideo: false });
  assert.equal(missing.noAudio, true); assert.equal(missing.noVideo, true); assert.equal(missing.canRender, false);
  assert.equal(mvReadiness({ ...base, hasScript: false }).noScript, true);
});
test("scope and edits invalidate previous approval even on return", () => {
  const signature = (scope: string, lyricLines = lines, instrumental = false) => mvSignature(scope, "audio", "0, 1", lyricLines, cuts, "manual", instrumental);
  const approved = signature("project-a:revision-1");
  assert.notEqual(signature("project-a:revision-2"), approved);
  assert.notEqual(signature("project-b:revision-1"), approved);
  assert.notEqual(signature("project-a:revision-1", [{ ...lines[0], text: "Changed" }]), approved);
  assert.notEqual(signature("project-a:revision-1", lines, true), approved);
});
test("synchronous request lock prevents duplicates and permits retry after failure", () => {
  const lock = createMvRequestLock();
  assert.equal(lock.begin(), true); assert.equal(lock.begin(), false);
  assert.equal(mvReadiness({ ...base, busy: true }).canRender, false);
  lock.finish(); assert.equal(lock.begin(), true); lock.finish();
});
