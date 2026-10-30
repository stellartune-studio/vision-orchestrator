import assert from "node:assert/strict";
import { test } from "node:test";
import { assessProcesses, type ProcessSnapshot } from "../src/gen/processIdentity.ts";

const p = (pid: number, parent: number) => ({ pid, parent, started: "2026-10-28T01:00:00Z", commandHash: "a".repeat(64), executableHash: "b".repeat(64) });
const original: ProcessSnapshot = { machine: "c".repeat(64), boot: "boot", processes: [p(1, 0), p(2, 1)] };
test("process reconciliation requires complete same-machine facts and detects PID reuse", () => {
  assert.equal(assessProcesses(original, original), "active");
  assert.equal(assessProcesses(original, null), "unknown");
  assert.equal(assessProcesses(original, { ...original, boot: "different" }), "unknown");
  assert.equal(assessProcesses(original, { ...original, machine: "d".repeat(64) }), "unknown");
  assert.equal(assessProcesses(original, { ...original, processes: [] }), "ended");
  assert.equal(assessProcesses(original, { ...original, processes: [{ ...p(1, 0), started: "2026-10-28T02:00:00Z" }] }), "ended");
  assert.equal(assessProcesses(original, { ...original, processes: [{ ...p(1, 0), commandHash: "e".repeat(64) }] }), "unknown");
  assert.equal(assessProcesses({ ...original, processes: [p(1, 0)] }, original), "unknown");
  assert.equal(assessProcesses(original, { ...original, processes: [p(2, 1)] }), "active");
});
