import { extname } from "node:path";
import { BadRequestError } from "../repos/errors.ts";

/**
 * Media types the app stores and serves — images, video, audio, plain
 * text. Active content (html/svg/xml) and executables are absent by
 * design: they can neither be uploaded nor served.
 *
 * `kind` is the content signature family that the raw bytes must
 * sniff as, so an extension/mime claim has to match the payload.
 */
const EXTS: Record<string, { mimes: string[]; kind: string }> = {
  ".png": { mimes: ["image/png"], kind: "png" },
  ".jpg": { mimes: ["image/jpeg"], kind: "jpeg" },
  ".jpeg": { mimes: ["image/jpeg"], kind: "jpeg" },
  ".webp": { mimes: ["image/webp"], kind: "webp" },
  ".gif": { mimes: ["image/gif"], kind: "gif" },
  ".mp4": { mimes: ["video/mp4"], kind: "isobmff" },
  ".mov": { mimes: ["video/quicktime"], kind: "isobmff" },
  ".m4a": { mimes: ["audio/mp4", "audio/x-m4a"], kind: "isobmff" },
  ".webm": { mimes: ["video/webm"], kind: "webm" },
  ".mp3": { mimes: ["audio/mpeg"], kind: "mp3" },
  ".wav": { mimes: ["audio/wav"], kind: "wav" },
  ".txt": { mimes: ["text/plain"], kind: "text" },
  ".md": { mimes: ["text/markdown", "text/plain"], kind: "text" },
  ".json": { mimes: ["application/json"], kind: "json" },
};

const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXTS).flatMap(([ext, v]) =>
    v.mimes.map((m) => [m, ext] as const),
  ),
);

const ascii = (b: Buffer, off: number, len: number) =>
  b.length >= off + len ? b.subarray(off, off + len).toString("ascii") : "";

/** Content signature family — magic bytes, not caller claims. */
function sniffKind(bytes: Buffer): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG"
  )
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
    return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return "webp";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE")
    return "wav";
  if (ascii(bytes, 4, 4) === "ftyp") return "isobmff";
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return "webm";
  if (
    ascii(bytes, 0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  )
    return "mp3";
  // text family: must decode as UTF-8 and contain no NUL bytes
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (s.indexOf(String.fromCharCode(0)) >= 0) return "unknown";
    const t = s.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        JSON.parse(s);
        return "json";
      } catch {
        return "text";
      }
    }
    return "text";
  } catch {
    return "unknown";
  }
}

/**
 * Resolve the caller-supplied file name + mime + content into the ONE
 * canonical {ext, mime} the server will store — or reject.
 *
 *   - a present extension must be allowlisted
 *   - an absent extension requires a known mime to stand in
 *   - a declared mime must agree with the extension
 *   - the raw bytes must sniff as the resolved type
 */
export function checkedAssetType(
  name: string | undefined,
  mime: string | undefined,
  bytes: Buffer,
): { ext: string; mime: string } {
  const ext = name ? extname(name).toLowerCase() : "";
  if (ext && !EXTS[ext]) {
    throw new BadRequestError(`unsupported file extension "${ext}"`);
  }
  let canonExt = ext;
  if (!canonExt) {
    canonExt = (mime && MIME_TO_EXT[mime]) || "";
    if (!canonExt) {
      throw new BadRequestError(
        "a known file type (allowlisted extension or mime) is required",
      );
    }
  }
  if (mime && !EXTS[canonExt].mimes.includes(mime)) {
    throw new BadRequestError(
      `mime "${mime}" does not match "${canonExt}" content`,
    );
  }
  if (sniffKind(bytes) !== EXTS[canonExt].kind) {
    throw new BadRequestError(
      `content does not look like ${EXTS[canonExt].mimes[0]}`,
    );
  }
  return { ext: canonExt, mime: EXTS[canonExt].mimes[0] };
}

/**
 * Canonical serve-time mime for a stored path — derived from the
 * allowlisted extension only, never from the stored/user mime.
 * undefined = not a servable type (refuse to serve).
 */
export function mimeForPath(p: string): string | undefined {
  return EXTS[extname(p).toLowerCase()]?.mimes[0];
}
