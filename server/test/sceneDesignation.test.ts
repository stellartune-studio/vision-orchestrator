import assert from "node:assert/strict";
import test from "node:test";
import { parseSceneDesignation } from "../src/domain/sceneDesignation.ts";

test("scene designation accepts supported Japanese heading forms with non-empty body", () => {
  for (const content of [
    "場面: 駅前。少女が立つ。",
    "場面 3：夜の駅前。\n少女が歩く。",
    "シーン12: 夜の駅前。",
  ]) {
    assert.deepEqual(parseSceneDesignation(content), { ok: true });
  }
});

test("scene designation accepts supported English Scene heading forms", () => {
  for (const content of [
    "Scene: morning at the station.",
    "Scene 1: morning at the station.",
    "SCENE 2: Night at home.",
    "scene 3：dusk at the quay.",
    "Scene 1 - a girl stands in the rain.",
    "Scene - wide shot of the platform.\nShe waits.",
  ]) {
    assert.deepEqual(parseSceneDesignation(content), { ok: true }, content);
  }
});

test("scene designation refuses ambiguous and unsupported formats", () => {
  const cases: Array<[string, RegExp]> = [
    ["Note: Scene: is an example.", /inline mention/],
    ["場面:", /no body text/],
    ["Scene:", /no body text/],
    ["前置き。\n場面: 駅前。", /not at the start/],
    ["Intro.\nScene 1: night.", /not at the start/],
    ["場面: 朝。\nシーン: 夜。", /mixed/],
    ["Scene 1: morning.\nシーン: night.", /mixed/],
    ["場面: 朝。\n場面2: 夜。", /2 accepted scene headings/],
    ["Scene 1: morning.\nScene 2: night.", /2 accepted scene headings/],
    ["場面1: 朝。\nScene 2: 夜。", /2 accepted scene headings/],
    ["駅前。少女が立つ。", /No identifying scene designation/],
    ["シーン: 駅前。少女が立つ。", /Accepted form|accepted form/],
  ];

  for (const [content, reason] of cases) {
    const result = parseSceneDesignation(content);
    assert.equal(result.ok, false, content);
    if (!result.ok) assert.match(result.reason, reason, content);
  }
});