/** Deterministic display fixtures for the shared workbench backdrop
 *  preview. The `key` of each card is a persisted value
 *  (shared/src WORKBENCH_BACKDROPS) — the artwork itself stays a mock. */
export const MOCK_BACKDROPS = [
  { key: "rain", nameKey: "design.scene.rain", typeKey: "design.scene.rainType", color: "#36574f", icon: "rain" },
  { key: "studio", nameKey: "design.scene.studio", typeKey: "design.scene.studioType", color: "#8a6846", icon: "sun" },
  { key: "library", nameKey: "design.scene.library", typeKey: "design.scene.libraryType", color: "#48547e", icon: "moon" },
] as const;
