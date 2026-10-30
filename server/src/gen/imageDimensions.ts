import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isUnder } from "../util/paths.ts";

/** Read TIFF IFD0 orientation, used by ComfyUI's PIL exif_transpose. */
export function tiffOrientation(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 8 > bytes.length) throw new Error("Invalid EXIF metadata");
  const order = bytes.toString("ascii", offset, offset + 2);
  if (order !== "II" && order !== "MM") throw new Error("Invalid EXIF byte order");
  const u16 = (at: number) => { if (at < offset || at + 2 > bytes.length) throw new Error("Truncated EXIF metadata"); return order === "II" ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at); };
  const u32 = (at: number) => { if (at < offset || at + 4 > bytes.length) throw new Error("Truncated EXIF metadata"); return order === "II" ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at); };
  if (u16(offset + 2) !== 42) throw new Error("Invalid EXIF TIFF header");
  const directory = offset + u32(offset + 4);
  const count = u16(directory);
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > bytes.length) throw new Error("Truncated EXIF directory");
    if (u16(entry) === 0x0112) {
      if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) throw new Error("Unsupported EXIF orientation");
      const orientation = u16(entry + 8);
      if (orientation < 1 || orientation > 8) throw new Error("Invalid EXIF orientation");
      return orientation;
    }
  }
  return 1;
}

/** Detect orientation metadata conservatively. Unparseable candidates fail closed. */
export function imageExifOrientation(bytes: Buffer): number | null {
  const candidates: number[] = [];
  const jpegMarker = bytes.indexOf(Buffer.from("Exif\0\0", "binary"));
  if (jpegMarker >= 0) candidates.push(tiffOrientation(bytes, jpegMarker + 6));
  const pngMarker = bytes.indexOf(Buffer.from("eXIf"));
  if (pngMarker >= 0) candidates.push(tiffOrientation(bytes, pngMarker + 4));
  const webpMarker = bytes.indexOf(Buffer.from("EXIF"));
  if (webpMarker >= 0) {
    const start = webpMarker + 8;
    const prefix = bytes.toString("binary", start, start + 6);
    candidates.push(tiffOrientation(bytes, start + (prefix === "Exif\0\0" ? 6 : 0)));
  }
  if (new Set(candidates).size > 1) throw new Error("Conflicting EXIF orientation metadata");
  return candidates[0] ?? null;
}

/** Read local media metadata without a shell or network protocols. */
export async function probeImageDimensions(path: string, root: string, maxBytes: number): Promise<{ width: number; height: number }> {
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  if (!isUnder(realRoot, realPath)) throw new Error("Image is outside managed asset storage");
  const info = statSync(realPath);
  if (!info.isFile()) throw new Error("Image is not a regular file");
  if (info.size <= 0 || info.size > maxBytes) throw new Error("Image is empty or exceeds the configured request size limit");
  // ffprobe does not consistently expose EXIF orientation for still images,
  // while ComfyUI's LoadImage applies it. Parse it separately and fail closed
  // on ambiguous metadata. A marker-like byte sequence may be rejected.
  const fd = openSync(realPath, "r");
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size <= 0 || opened.size > maxBytes) throw new Error("Image is empty or exceeds the configured request size limit");
    bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, null);
      if (count === 0) throw new Error("Image changed while reading metadata");
      read += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error("Image changed while reading metadata");
  } finally { closeSync(fd); }
  const orientation = imageExifOrientation(bytes);
  // Bound metadata output and runtime for malformed inputs. The executable is
  // configurable because ffprobe is an optional external tool, not bundled.
  const binary = process.env.FFPROBE_BIN?.trim() || "ffprobe";
  const output = await new Promise<string>((resolve, reject) => {
    execFile(binary, ["-v", "error", "-protocol_whitelist", "file", "-f", "image2", "-pattern_type", "none", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:stream_tags=rotate", "-of", "json", realPath], { timeout: 10000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error("Unable to read image dimensions with ffprobe"));
      else resolve(stdout);
    });
  });
  const parsed = JSON.parse(output) as { streams?: { width?: unknown; height?: unknown; side_data_list?: { rotation?: unknown }[]; tags?: { rotate?: unknown } }[] };
  const stream = parsed.streams?.[0];
  let width = Number(stream?.width), height = Number(stream?.height);
  const rotations = [...(stream?.side_data_list ?? []).map((value) => value.rotation), stream?.tags?.rotate].filter((value) => value != null).map(Number);
  if (rotations.some((rotation) => !Number.isFinite(rotation) || rotation % 90 !== 0)) throw new Error("Unsupported image orientation");
  if (rotations.length > 1 && rotations.some((rotation) => ((rotation % 360) + 360) % 360 !== ((rotations[0] % 360) + 360) % 360)) throw new Error("Conflicting image orientation metadata");
  const rotatedByExif = orientation != null && orientation >= 5;
  if (orientation != null && rotations.length && rotatedByExif !== (Math.abs(rotations[0] % 180) === 90)) throw new Error("Conflicting orientation metadata");
  if (orientation != null ? rotatedByExif : rotations.length > 0 && Math.abs(rotations[0] % 180) === 90) [width, height] = [height, width];
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw new Error("Image dimensions are unavailable");
  return { width, height };
}
