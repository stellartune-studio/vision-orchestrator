import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const { checkVerificationLaunch } = await import("../../scripts/ui-verify/real-server.mjs");

test("verification launcher rejects DATA_DIR typo and production path before any server import", () => {
  const root = mkdtempSync(join(tmpdir(), "vo-launch-guard-"));
  try {
    const prod = join(root, "data"); mkdirSync(prod);
    const sentinel = join(prod, "app.db"); writeFileSync(sentinel, "fixture sentinel");
    assert.equal(checkVerificationLaunch({ DATA_DIR: join(root, "scratch") }, root).ok, false);
    assert.equal(checkVerificationLaunch({ VO_DATA_DIR: prod }, root).ok, false);
    const scratch = join(root, "scratch");
    assert.deepEqual(checkVerificationLaunch({ VO_DATA_DIR: scratch }, root), { ok: true, dataDir: scratch });
    const entry = resolve(import.meta.dirname, "../../scripts/ui-verify/real-server.mjs");
    const env: Record<string, string | undefined> = { ...process.env, DATA_DIR: scratch }; delete env.VO_DATA_DIR;
    const refused = spawnSync(process.execPath, [entry, "--check-only"], { env, encoding: "utf8" });
    assert.equal(refused.status, 2); assert.match(refused.stderr, /before config\/DB access/);
    const accepted = spawnSync(process.execPath, [entry, "--check-only"], { env: { ...env, VO_DATA_DIR: scratch }, encoding: "utf8" });
    assert.equal(accepted.status, 0); assert.equal(JSON.parse(accepted.stdout).server_started, false);
    assert.equal(existsSync(scratch), false); assert.equal(readFileSync(sentinel, "utf8"), "fixture sentinel");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

