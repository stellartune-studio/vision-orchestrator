export declare function checkScratchDataDir(
  explicitDir: string | undefined | null,
  prodDataDir: string,
): { ok: true; dataDir: string } | { ok: false; reason: string };
