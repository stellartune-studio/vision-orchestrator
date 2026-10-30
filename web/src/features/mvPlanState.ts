export type LyricDraft = { start: string; end: string; text: string };
export type CutDraft = { start: string; video_asset_id: string };
export function mvLines(instrumental: boolean, lines: LyricDraft[]) {
  return (instrumental ? [] : lines).map((line) => ({ start: Number(line.start), end: Number(line.end), text: line.text }));
}
export function mvFont(instrumental: boolean, fontId: string): { font_id?: string } {
  return instrumental ? {} : { font_id: fontId };
}
export function mvSignature(scope: string, audio: string, beats: string, lines: LyricDraft[], cuts: CutDraft[], origin: string, instrumental: boolean): string {
  return JSON.stringify([scope, audio, beats, instrumental ? [] : lines, cuts, origin]);
}
export function mvReadiness(input: { hasScript: boolean; hasBlueprint: boolean; audioCount: number; videoCount: number; adopted: boolean; changed: boolean; hasVideo: boolean; instrumental: boolean; hasFont: boolean; busy: boolean }) {
  return {
    noScript: !input.hasScript,
    noAudio: input.hasScript && input.hasBlueprint && !input.audioCount,
    noVideo: input.hasScript && input.hasBlueprint && !input.videoCount,
    plan: !input.adopted ? "pending" : input.changed ? "stale" : "ready",
    missingVideo: !input.hasVideo,
    missingFont: !input.instrumental && !input.hasFont,
    canRender: input.adopted && !input.changed && input.hasVideo && (input.instrumental || input.hasFont) && !input.busy,
  } as const;
}
/** Synchronous lock blocks repeated events before React has rendered disabled controls. */
export function createMvRequestLock() {
  let active = false;
  return { begin() { if (active) return false; active = true; return true; }, finish() { active = false; } };
}
