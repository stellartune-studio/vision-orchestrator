import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { Asset } from "@vo/shared";
import { isUnder } from "../util/paths.ts";
import { UnprocessableError } from "../repos/errors.ts";

/** Verify a frozen asset before use. Callers must stage these bytes, not reopen
 * the path, so the renderer cannot consume different bytes after this check. */
export function verifiedPromotionAsset(asset: Asset | undefined, projectId: string, root: string, maxBytes: number, mime: string): Buffer {
  if (!asset || asset.owner_kind !== "project" || asset.owner_id !== projectId || asset.mime !== mime) throw new UnprocessableError("Promotion asset must be a project-owned file of the required type");
  if (!asset.sha256 || !/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new UnprocessableError("Promotion asset has no verifiable content hash");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new UnprocessableError("Invalid asset size limit");
  let file: string;
  try { file = realpathSync(asset.path); if (!isUnder(realpathSync(root), file)) throw new Error("outside root"); }
  catch { throw new UnprocessableError("Promotion asset is missing or outside managed storage"); }
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new UnprocessableError("Promotion asset is empty or exceeds its size limit");
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, null); if (!count) throw new UnprocessableError("Promotion asset changed during reading"); read += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new UnprocessableError("Promotion asset changed during reading");
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256.toLowerCase()) throw new UnprocessableError("Promotion asset content does not match its registered hash");
    if (mime === "image/png" && (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0 || bytes.readUInt32BE(16) > 16384 || bytes.readUInt32BE(20) > 16384)) throw new UnprocessableError("Promotion logo has an invalid PNG header or dimensions");
    return bytes;
  } finally { closeSync(fd); }
}
