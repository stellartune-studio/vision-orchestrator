export declare const REPO_ROOT: string;
export declare function defaultManifestPath(): string;
export declare function assertMockEndpoints(env: {
  api: string;
  web: string;
}): Promise<{ ok: boolean; reasons: string[] }>;
export declare function requireMockEndpoints(env: {
  api: string;
  web: string;
}): Promise<void>;
export declare function fetchProjectState(api: string, projectId: string): Promise<any>;
export declare function checkScratchDbFile(
  dbPath: string | undefined | null,
  prodDataDir?: string,
): { ok: true; dbPath: string } | { ok: false; reason: string };
export declare function verifyEntitiesInDb(
  dbPath: string,
  ids: {
    projects: string[];
    documents: string[];
    revisions: string[];
    blueprintVersions: string[];
    characters: string[];
  },
): { ok: boolean; missing: string[] };
export declare function saveManifest(manifest: unknown, path?: string): string;
export declare function loadManifest(path?: string): {
  run_id: string;
  projects: Record<string, any>;
};
export declare function stateFingerprint(state: any): any;
export declare function diffState(before: any, after: any): string[];
