import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UnprocessableError } from "../repos/errors.ts";

const exec = promisify(execFile);
// A lower bound prevents a successful preview with unreadably tiny text.
export const MIN_PROMOTION_FONT_PX = 12;
// Measurement canvas is deliberately bounded; an edge hit is treated as overflow.
const MEASURE_WIDTH = 8192;
const MEASURE_HEIGHT = 2048;
const MARGIN = 8;
// Four pixels of padding are also applied to the final title origin.
const PADDING = 4;

export interface TextBounds { width: number; height: number; clipped: boolean }
const NO_LINE_START = /^[、。，．！？：；）］｝〕〉》」』】ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー]/u;
const NO_LINE_END = /[（［｛〔〈《「『【]$/u;
const MAX_WRAPPED_LINES = 12;
export const promotionLineHeight = (size: number): number => Math.ceil(size * 1.2);

/** Separate files avoid FFmpeg drawing a missing-glyph box at a newline. */
export function stagePromotionLines(cwd: string, text: string): number {
  const lines = text.split("\n");
  if (lines.length > MAX_WRAPPED_LINES) throw new UnprocessableError("Title requires too many lines");
  if (lines.length > 1) lines.forEach((line, index) => writeFileSync(join(cwd, `title-line-${index}.txt`), line));
  return lines.length;
}

/** Greedy measured grapheme wrapping, preserving explicit line breaks. */
export async function wrapPromotionText(text: string, width: number, measure: (line: string) => Promise<number>): Promise<string> {
  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let remaining = Array.from(segmenter.segment(paragraph), (part) => part.segment);
    if (!remaining.length) { lines.push(""); if (lines.length > MAX_WRAPPED_LINES) throw new UnprocessableError("Title requires too many lines"); continue; }
    while (remaining.length) {
      let low = 1, high = remaining.length, best = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2), candidate = remaining.slice(0, middle).join("");
        if (await measure(candidate) <= width) { best = middle; low = middle + 1; } else high = middle - 1;
      }
      if (!best) throw new UnprocessableError("Title cannot wrap within its width");
      while (best < remaining.length && best > 0 && (NO_LINE_END.test(remaining[best - 1]) || NO_LINE_START.test(remaining[best]))) best--;
      if (!best) throw new UnprocessableError("Title cannot wrap without an invalid line break");
      lines.push(remaining.slice(0, best).join("")); remaining = remaining.slice(best);
      if (lines.length > MAX_WRAPPED_LINES) throw new UnprocessableError("Title requires too many lines");
    }
  }
  return lines.join("\n");
}

/** Binary search only on positive integer sizes; fail closed if metrics are unavailable. */
export async function fitPromotionText(box: { width: number; height: number }, maxSize: number, measure: (size: number) => Promise<TextBounds>): Promise<number> {
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0 || !Number.isFinite(maxSize)) throw new UnprocessableError("Invalid title box dimensions");
  let low = MIN_PROMOTION_FONT_PX, high = Math.min(256, Math.floor(maxSize)), best = 0;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const bounds = await measure(size);
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) throw new UnprocessableError("Unable to measure title text");
    if (!bounds.clipped && bounds.width <= box.width && bounds.height <= box.height) { best = size; low = size + 1; }
    else high = size - 1;
  }
  if (!best) throw new UnprocessableError(`Title does not fit at the minimum font size (${MIN_PROMOTION_FONT_PX}px)`);
  return best;
}

/** Measure actual rasterized glyph bounds with the same FFmpeg and staged font.
 * Explicit line breaks are retained; no automatic line breaks are invented. */
export async function measurePromotionText(ffmpeg: string, cwd: string, size: number): Promise<TextBounds> {
  const title = readFileSync(join(cwd, "title.txt"), "utf8");
  const lines = title.split("\n");
  stagePromotionLines(cwd, title);
  // Bound the canvas to the title while retaining generous room for glyph
  // bearings. A boundary hit remains a hard overflow, never a false fit.
  const width = Math.min(MEASURE_WIDTH, Math.max(256, Math.max(...lines.map((line) => Array.from(line).length)) * size * 2 + MARGIN * 2));
  const height = Math.min(MEASURE_HEIGHT, Math.max(128, Math.ceil((lines.length * size * 3 + MARGIN * 2) / 2) * 2));
  const draws = lines.flatMap((line, index) => line.length ? [`drawtext=fontfile=font.ttc:ft_load_flags=no_bitmap:textfile=${lines.length === 1 ? "title.txt" : `title-line-${index}.txt`}:expansion=none:fontcolor=white:fontsize=${size}:x=${MARGIN}:y=${MARGIN + index * promotionLineHeight(size)}`] : []);
  if (!draws.length) throw new UnprocessableError("Unable to measure title text");
  const filter = `${draws.join(",")},bbox=min_val=20`;
  let stderr: string;
  try {
    ({ stderr } = await exec(ffmpeg, ["-hide_banner", "-loglevel", "info", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:d=0.04`, "-vf", filter, "-frames:v", "1", "-f", "null", "-"], { cwd, timeout: 30000, maxBuffer: 262144, windowsHide: true }));
  } catch {
    throw new UnprocessableError("Unable to measure title using FFmpeg and the configured font");
  }
  const match = /x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/.exec(stderr);
  if (!match) throw new UnprocessableError("Unable to measure title text with the configured font");
  const [, left, right, top, bottom] = match.map(Number);
  // Include leading bearings and line spacing relative to drawtext's origin.
  return { width: right - MARGIN + 1 + PADDING, height: bottom - MARGIN + 1 + PADDING, clipped: left < MARGIN - PADDING || top < MARGIN - PADDING || right >= width - 1 || bottom >= height - 1 };
}
