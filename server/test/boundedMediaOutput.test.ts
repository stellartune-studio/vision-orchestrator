import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedMediaOutput } from "../src/gen/boundedMediaOutput.ts";

test("media output is rejected beyond the byte limit before any file write", async () => {
  const ok = await boundedMediaOutput(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(100))"], process.cwd(), 100);
  assert.equal(ok.length, 100);
  await assert.rejects(boundedMediaOutput(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(101))"], process.cwd(), 100), /size limit/);
});
import { execFileSync } from "node:child_process";
test("bounded fragmented MP4 preserves an audio impulse at its intended time", () => {
  const sampleRate = 16000, count = sampleRate * 2;
  const wav = Buffer.alloc(44 + count * 2); wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(count * 2, 40); wav.writeInt16LE(30000, 44 + 1600 * 2);
  const encoded = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=2", "-f", "wav", "-i", "pipe:0", "-c:v", "libx264", "-bf", "0", "-c:a", "aac", "-avoid_negative_ts", "disabled", "-movflags", "+frag_keyframe+delay_moov", "-f", "mp4", "pipe:1"], { input: wav, windowsHide: true });
  const decoded = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", String(sampleRate), "pipe:1"], { input: encoded, windowsHide: true });
  let peak = 0; for (let i = 1; i < decoded.length / 2; i++) if (Math.abs(decoded.readInt16LE(i * 2)) > Math.abs(decoded.readInt16LE(peak * 2))) peak = i;
  assert.ok(Math.abs(peak - 1600) <= 1, `audio impulse shifted to ${peak} samples`);
});
