import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeMvBeats, estimateBeatCandidates } from "../src/gen/mvBeatAnalysis.ts";

function pcm(seconds: number, times: number[], amplitude = 0.5): Buffer {
  const data = Buffer.alloc(seconds * 2000);
  for (const time of times) for (let n = 0; n < 20; n++) data.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(n * Math.PI / 4)), Math.round(time * 1000 + n) * 2);
  return data;
}
function wave(data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(1000, 24); header.writeUInt32LE(2000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
test("beat candidates retain seconds and flag silence, low volume and changing tempo", () => {
  const beats = [0.5, 1, 1.5, 2, 2.5];
  const regular = estimateBeatCandidates(pcm(3, beats), 3);
  assert.equal(regular.confidence, "moderate"); assert.deepEqual(regular.points, beats);
  assert.deepEqual(estimateBeatCandidates(pcm(3, []), 3).points, []);
  assert.equal(estimateBeatCandidates(pcm(3, beats, 0.001), 3).reason, "silent_or_too_quiet");
  assert.equal(estimateBeatCandidates(pcm(3, [0.5, 1, 1.3, 2.1]), 3).confidence, "low");
  assert.throws(() => estimateBeatCandidates(pcm(3, beats), 4), /duration differs/);
  assert.throws(() => estimateBeatCandidates(Buffer.alloc(0), 3601), /duration/);
});
test("existing FFmpeg decodes a synthetic WAV and removes staged audio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-beats-"));
  try {
    const result = await analyzeMvBeats(wave(pcm(3, [0.5, 1, 1.5, 2, 2.5])), dir, "ffmpeg", "ffprobe");
    assert.deepEqual(result.points, [0.5, 1, 1.5, 2, 2.5]);
    assert.equal(result.duration, 3); assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
