/** Project-scoped comparison preferences; null means the comparison panel is closed. */
export interface ComparisonSelection {
  ids: string[] | null;
  version: number | null;
  stale: boolean;
}
