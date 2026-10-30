export type Dimensions = { width: number; height: number };

/** Accept only complete positive pixel dimensions, never policy strings. */
export function pixelDimensions(width: unknown, height: unknown): Dimensions | null {
  return typeof width === "number" && typeof height === "number" &&
    Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

export function requestedDimensions(inputs: string): Dimensions | null {
  try {
    const settings = JSON.parse(inputs)?.settings;
    return pixelDimensions(settings?.width, settings?.height);
  } catch {
    return null;
  }
}

/** Unknown output must never be replaced by the requested size. */
export function dimensionsDiffer(requested: Dimensions | null, measured: Dimensions | null): boolean {
  return !!requested && !!measured &&
    (requested.width !== measured.width || requested.height !== measured.height);
}
