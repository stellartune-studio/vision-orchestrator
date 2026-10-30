import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UnprocessableError } from "../repos/errors.ts";
const exec = promisify(execFile);

/** Buffer the media stream with a hard byte limit before writing any output file. */
export async function boundedMediaOutput(bin: string, args: string[], cwd: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new UnprocessableError("Invalid output size limit");
  try {
    const result = await exec(bin, args, { cwd, encoding: "buffer", timeout: 1800000, maxBuffer: maxBytes, windowsHide: true });
    if (!result.stdout.length || result.stdout.length > maxBytes) throw new Error("Invalid output size");
    return result.stdout;
  } catch { throw new UnprocessableError("Media rendering failed or exceeded the configured output size limit"); }
}
