import { UnprocessableError } from "../repos/errors.ts";

/** Inspect the first SFNT face, matching the default face used by drawtext. */
export function missingFontCodepoints(font: Buffer, text: string): number[] {
  const fail = (): never => { throw new UnprocessableError("Configured font coverage could not be verified"); };
  const u16 = (offset: number) => { if (offset < 0 || offset + 2 > font.length) return fail(); return font.readUInt16BE(offset); };
  const u32 = (offset: number) => { if (offset < 0 || offset + 4 > font.length) return fail(); return font.readUInt32BE(offset); };
  const face = font.toString("ascii", 0, 4) === "ttcf" ? u32(12) : 0;
  const tables = u16(face + 4);
  let cmap = 0;
  for (let index = 0; index < tables; index++) {
    const entry = face + 12 + index * 16;
    if (font.toString("ascii", entry, entry + 4) === "cmap") { cmap = u32(entry + 8); break; }
  }
  if (!cmap) return fail();
  const records = u16(cmap + 2);
  const candidates: { offset: number; format: number; rank: number }[] = [];
  for (let index = 0; index < records; index++) {
    const entry = cmap + 4 + index * 8, platform = u16(entry), encoding = u16(entry + 2), offset = cmap + u32(entry + 4);
    const format = u16(offset);
    if ((platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) && (format === 4 || format === 12)) candidates.push({ offset, format, rank: format === 12 ? 2 : 1 });
  }
  const table = candidates.sort((a, b) => b.rank - a.rank)[0];
  if (!table) return fail();
  const hasGlyph = (codepoint: number): boolean => {
    if (table.format === 12) {
      const length = u32(table.offset + 4), groups = u32(table.offset + 12);
      if (length < 16 || table.offset + length > font.length || groups > Math.floor((length - 16) / 12)) return fail();
      let left = 0, right = groups - 1;
      while (left <= right) { const middle = (left + right) >>> 1, pos = table.offset + 16 + middle * 12, start = u32(pos), end = u32(pos + 4); if (codepoint < start) right = middle - 1; else if (codepoint > end) left = middle + 1; else return u32(pos + 8) + codepoint - start !== 0; }
      return false;
    }
    if (codepoint > 0xffff) return false;
    const length = u16(table.offset + 2), count = u16(table.offset + 6) / 2;
    if (!Number.isInteger(count) || length < 16 + count * 8 || table.offset + length > font.length) return fail();
    const endOffset = table.offset + 14, startOffset = endOffset + count * 2 + 2, deltaOffset = startOffset + count * 2, rangeOffset = deltaOffset + count * 2;
    for (let index = 0; index < count; index++) {
      if (codepoint > u16(endOffset + index * 2)) continue;
      const start = u16(startOffset + index * 2); if (codepoint < start) return false;
      const delta = u16(deltaOffset + index * 2), range = u16(rangeOffset + index * 2);
      if (!range) return ((codepoint + delta) & 0xffff) !== 0;
      const glyphOffset = rangeOffset + index * 2 + range + 2 * (codepoint - start);
      if (glyphOffset + 2 > table.offset + length) return fail();
      const glyph = u16(glyphOffset); return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  };
  const missing = new Set<number>();
  for (const char of text) {
    const codepoint = char.codePointAt(0)!;
    if (codepoint === 10 || codepoint === 13) continue;
    // Variation selectors and ZWJ need shaping/sequence coverage beyond cmap.
    if (codepoint === 0x200d || (codepoint >= 0xfe00 && codepoint <= 0xfe0f) || (codepoint >= 0xe0100 && codepoint <= 0xe01ef) || !hasGlyph(codepoint)) missing.add(codepoint);
  }
  return [...missing];
}

export function requireFontCoverage(font: Buffer, text: string): void {
  const missing = missingFontCodepoints(font, text);
  if (missing.length) throw new UnprocessableError(`Configured font lacks verified glyphs for ${missing.slice(0, 8).map((codepoint) => `U+${codepoint.toString(16).toUpperCase()}`).join(", ")}`);
}
