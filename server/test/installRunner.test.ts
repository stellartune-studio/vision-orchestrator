import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planEnvironment } from "../src/environment/setupService.ts";
import { runInstallSteps, installStatus, assertInstallCanResume } from "../src/environment/installRunner.ts";
import { installCommand } from "../src/environment/managedInstaller.ts";

test("persisted installer resumes partial cached venv and reruns idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "vo-install-fixture-"));
  try {
    const file = join(root, "state.json"), venv = join(root, "venv"), marker = join(root, "done");
    const plan = planEnvironment("managed"); let fail = true, created = 0;
    const steps = [
      { id: "venv", ready: async () => existsSync(join(venv, "pyvenv.cfg")), apply: async (record: (pid: number | undefined) => void) => {
        await installCommand("uv", ["venv", "--offline", "--python", "3.13.17", venv], record); created++;
        if (fail) throw new Error("fixture interruption after actual cached venv creation");
      } },
      { id: "finish", ready: async () => existsSync(marker), apply: async () => { writeFileSync(marker, "fixture"); } },
    ];
    await assert.rejects(runInstallSteps({ plan, file, steps, fixture: true }), /fixture interruption/);
    assert.equal(installStatus(file)?.status, "failed");
    fail = false;
    const resumed = await runInstallSteps({ plan, file, steps, fixture: true });
    assert.equal(resumed.status, "mock_completed"); assert.equal(resumed.mock, true);
    assert.equal(resumed.attempts, 2); assert.equal(created, 1);
    assert.deepEqual(resumed.evidence?.applied_steps, ["finish"]);
    const again = await runInstallSteps({ plan, file, steps, fixture: true });
    assert.deepEqual(again.evidence?.applied_steps, []);
    assert.throws(() => assertInstallCanResume(file, { ...plan, revision: "changed" }), /plan changed/);
    const journal = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...journal, status: "running", executor_pid: process.pid }));
    assert.equal(installStatus(file)?.status, "interrupted");
    const final = await runInstallSteps({ plan, file, steps, fixture: true });
    assert.equal(final.attempts, 4); assert.equal(created, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
