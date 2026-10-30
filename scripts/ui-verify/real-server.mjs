// Verification-only entrypoint for the normal server composition (real or mock).
// Validate explicit isolation BEFORE importing configuration, migrations or DB code.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkScratchDataDir } from "./data-dir-guard.mjs";

export function checkVerificationLaunch(env, repoRoot) {
  return checkScratchDataDir(env.VO_DATA_DIR, resolve(repoRoot, "data"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const checked = checkVerificationLaunch(process.env, repoRoot);
  if (!checked.ok) {
    console.error(`REFUSING verification server before config/DB access: ${checked.reason}`);
    process.exitCode = 2;
  } else {
    process.env.VO_DATA_DIR = checked.dataDir;
    if (process.argv.includes("--check-only")) console.log(JSON.stringify({ isolated_data_dir: checked.dataDir, server_started: false }));
    else await import("../../server/src/index.ts");
  }
}
