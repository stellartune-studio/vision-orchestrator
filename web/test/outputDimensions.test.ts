import test from "node:test";
import assert from "node:assert/strict";
import { dimensionsDiffer, pixelDimensions, requestedDimensions } from "../src/features/outputDimensions.ts";

test("requested size accepts only a complete recorded numeric pair", () => {
  assert.deepEqual(requestedDimensions('{"settings":{"width":1280,"height":720}}'), { width: 1280, height: 720 });
  for (const inputs of ["null", "{}", "broken", '{"settings":{"width":1280}}', '{"settings":{"width":"1280","height":720}}']) {
    assert.equal(requestedDimensions(inputs), null);
  }
});

test("unloaded, invalid and fractional media dimensions stay unmeasured", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, "864", undefined]) {
    assert.equal(pixelDimensions(value, 480), null);
    assert.equal(pixelDimensions(864, value), null);
  }
  assert.deepEqual(pixelDimensions(864, 480), { width: 864, height: 480 });
});

test("compare measured output only; request and workflow inputs are not measurements", () => {
  const requested = { width: 1280, height: 720 };
  assert.equal(dimensionsDiffer(requested, null), false);
  assert.equal(dimensionsDiffer(null, { width: 864, height: 480 }), false);
  assert.equal(dimensionsDiffer(requested, { ...requested }), false);
  assert.equal(dimensionsDiffer(requested, { width: 864, height: 480 }), true);
  assert.equal(dimensionsDiffer(requested, { width: 1280, height: 480 }), true);
});
