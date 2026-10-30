import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { UnprocessableError } from "../repos/errors.ts";

const exec = promisify(execFile);

/** Probe verified staged bytes with file-only protocols, outside any DB transaction. */
export async function probeMvAudioDuration(bytes: Buffer, root: string, ffprobe: string): Promise<number> {
  const dir = mkdtempSync(join(root, ".mv-probe-"));
  try {
    writeFileSync(join(dir, "audio"), bytes, { flag: "wx" });
    let stdout: string;
    try {
      ({ stdout } = await exec(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "stream=codec_type:format=duration", "-of", "json", "audio"], { cwd: dir, timeout: 30000, maxBuffer: 65536, windowsHide: true }));
    } catch { throw new UnprocessableError("Unable to probe the selected audio file"); }
    const result = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
    const duration = Number(result.format?.duration);
    if (!result.streams?.some((stream) => stream.codec_type === "audio") || !Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new UnprocessableError("Selected audio has no supported duration within one hour");
    return duration;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
