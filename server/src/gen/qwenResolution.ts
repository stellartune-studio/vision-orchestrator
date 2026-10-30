/** Map a requested output area onto Qwen's 32-pixel resolution grid. */
export function qwenResolutionForArea(width?: number, height?: number): number {
  if (width == null || height == null) return 1024;
  const target = Math.sqrt(width * height);
  return Math.max(32, Math.min(4096, Math.round(target / 32) * 32));
}

/** Necessary (not sufficient) condition for exact Qwen reference output. */
export function qwenReferenceGridCompatible(width?: number, height?: number): boolean {
  return width == null || height == null || (width % 32 === 0 && height % 32 === 0);
}

/** Python's round() uses ties-to-even; ComfyUI's Qwen node uses it on a 32px grid. */
function roundTiesToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  return fraction === 0.5 ? lower + (lower % 2) : Math.round(value);
}

/** Predict the first-reference latent canvas used by QwenImage21TextEncode.
 *  Mirrors nodes_qwen.py: resolution 0 rounds each input axis; positive
 *  resolution preserves the reference ratio while rounding both axes. */
export function qwenReferenceCanvas(sourceWidth: number, sourceHeight: number, resolution: number): { width: number; height: number } {
  if (!Number.isSafeInteger(sourceWidth) || sourceWidth <= 0 || !Number.isSafeInteger(sourceHeight) || sourceHeight <= 0 || !Number.isSafeInteger(resolution) || resolution < 0 || resolution > 4096) {
    throw new Error("Invalid Qwen source dimensions or resolution");
  }
  const ratio = sourceWidth / sourceHeight;
  const width = resolution > 0 ? Math.sqrt(resolution * resolution * ratio) : sourceWidth;
  const height = resolution > 0 ? Math.sqrt(resolution * resolution / ratio) : sourceHeight;
  return { width: Math.max(32, roundTiesToEven(width / 32) * 32), height: Math.max(32, roundTiesToEven(height / 32) * 32) };
}
