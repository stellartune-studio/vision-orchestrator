export declare function checkVerificationLaunch(
  env: { VO_DATA_DIR?: string; DATA_DIR?: string },
  repoRoot: string,
): { ok: true; dataDir: string } | { ok: false; reason: string };
