import assert from "node:assert/strict";
import { test } from "node:test";
import { apiError, describeError } from "../src/api/client.ts";

test("apiError carries HTTP status, code and the server message", () => {
  const err = apiError(422, { error: "A source clip is shorter than its assigned interval", code: "unprocessable" });
  assert.equal(err.status, 422);
  assert.equal(err.code, "unprocessable");
  assert.equal(err.message, "A source clip is shorter than its assigned interval");
  assert.equal(describeError(err), "A source clip is shorter than its assigned interval");
});

test("apiError without a payload falls back to the status", () => {
  const err = apiError(409, null);
  assert.equal(err.status, 409);
  assert.equal(describeError(err), "HTTP 409");
});

test("status-less errors keep the connection-failure wording", () => {
  assert.match(describeError(new Error("Failed to fetch")), /Cannot reach the server/);
});
