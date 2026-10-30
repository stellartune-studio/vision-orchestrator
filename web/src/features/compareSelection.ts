/** Browser-local comparison preference; malformed values never cross projects. */
export function parseCompareSelection(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null) return null;
    if (!Array.isArray(parsed) || parsed.length > 2 || parsed.some((id) => typeof id !== "string" || !id || id.length > 128) || new Set(parsed).size !== parsed.length) return null;
    return parsed;
  } catch { return null; }
}
export const compareStorageKey = (projectId: string) => `vo.compare.v1:${projectId}`;
export function loadCompareSelection(projectId: string): string[] | null {
  try { return parseCompareSelection(localStorage.getItem(compareStorageKey(projectId))); } catch { return null; }
}
export function saveCompareSelection(projectId: string, value: string[] | null): void {
  try { localStorage.setItem(compareStorageKey(projectId), JSON.stringify(value)); } catch { /* unavailable storage leaves the current in-memory selection usable */ }
}
