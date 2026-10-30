// Shared data-dir guard for the ui-verify TEST server.
//
// The test server must only ever write to an explicitly nominated
// scratch directory — never the app's default data dir. This module
// is the single implementation used by test-server.mjs AND exercised
// directly by the regression test (server/test/dataDirGuard.test.ts);
// tests inject a dummy production dir instead of touching the real one.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Check an explicitly supplied data dir against the production dir.
 *
 * @param {string | undefined | null} explicitDir — the raw
 *   VO_DATA_DIR value read BEFORE any config/env-file merge (an
 *   env-file-provided path must never reach this function as
 *   "explicit").
 * @param {string} prodDataDir — the app's standard data directory
 *   (absolute or cwd-relative; normalized here).
 * @returns {{ ok: true, dataDir: string } | { ok: false, reason: string }}
 */
export function checkScratchDataDir(explicitDir, prodDataDir) {
  const prod = resolve(prodDataDir);
  if (!explicitDir || !explicitDir.trim()) {
    return {
      ok: false,
      reason:
        "VO_DATA_DIR is required. This test server refuses to fall back " +
        "to the app's default data dir — point it at a scratch directory.",
    };
  }
  const dataDir = resolve(explicitDir);
  // Compare normalized strings AND real paths where they exist —
  // junctions/aliases and case variants of the production dir are
  // refused too. A nonexistent path can't be the existing prod dir.
  const samePath = (a, b) =>
    process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  const realOf = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  if (
    samePath(dataDir, prod) ||
    samePath(realOf(dataDir), realOf(prod))
  ) {
    return {
      ok: false,
      reason:
        `VO_DATA_DIR (${dataDir}) resolves to the production data dir ` +
        `(${prod}). Pick a scratch directory instead.`,
    };
  }
  return { ok: true, dataDir };
}
