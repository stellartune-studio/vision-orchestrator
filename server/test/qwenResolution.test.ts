import assert from "node:assert/strict";
import { test } from "node:test";
import { qwenReferenceCanvas, qwenReferenceGridCompatible, qwenResolutionForArea } from "../src/gen/qwenResolution.ts";

test("qwen resolution defaults when either requested dimension is absent", () => {
  assert.equal(qwenResolutionForArea(), 1024);
  assert.equal(qwenResolutionForArea(1280), 1024);
  assert.equal(qwenResolutionForArea(undefined, 720), 1024);
});

test("qwen resolution rounds the geometric mean to the nearest 32 pixels", () => {
  assert.equal(qwenResolutionForArea(1280, 720), 960);
  assert.equal(qwenResolutionForArea(1000, 1000), 992);
});

test("qwen resolution stays within its supported lower and upper bounds", () => {
  assert.equal(qwenResolutionForArea(1, 1), 32);
  assert.equal(qwenResolutionForArea(10000, 10000), 4096);
});

test("reference output cannot exactly represent a non-grid dimension", () => {
  assert.equal(qwenReferenceGridCompatible(720, 1280), false);
  assert.equal(qwenReferenceGridCompatible(704, 1280), true);
  assert.equal(qwenReferenceGridCompatible(), true);
});

test("reference canvas follows the installed Qwen node's ratio and Python rounding", () => {
  assert.deepEqual(qwenReferenceCanvas(720, 1280, 960), { width: 704, height: 1280 });
  assert.deepEqual(qwenReferenceCanvas(720, 1280, 0), { width: 704, height: 1280 });
  assert.deepEqual(qwenReferenceCanvas(80, 112, 0), { width: 64, height: 128 });
  assert.deepEqual(qwenReferenceCanvas(1280, 720, 960), { width: 1280, height: 704 });
  assert.throws(() => qwenReferenceCanvas(0, 720, 960), /Invalid/);
});
