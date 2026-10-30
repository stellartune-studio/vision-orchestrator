import type { Asset } from "@vo/shared";

// Conservative cap avoids exceeding the default 32 MiB JSON/base64 limit; server limits can be lower.
export const MAX_SHELF_BYTES = 16 * 1024 * 1024;
const extensions = new Set(["png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "webm", "wav", "mp3", "m4a"]);
export function shelfFileError(name: string, size: number): "type" | "size" | null {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!extensions.has(ext)) return "type";
  if (!Number.isFinite(size) || size <= 0 || size > MAX_SHELF_BYTES) return "size";
  return null;
}
export function findShelfDuplicate(assets: Asset[], projectId: string, sha256: string): Asset | undefined {
  return assets.find((asset) => asset.owner_kind === "project" && asset.owner_id === projectId && asset.sha256?.toLowerCase() === sha256.toLowerCase());
}
