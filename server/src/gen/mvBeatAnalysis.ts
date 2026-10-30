import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { UnprocessableError } from "../repos/errors.ts";
import { probeMvAudioDuration } from "./mvAudio.ts";

// 1 kHz mono PCM bounds a one-hour decode to 7.2 MB and preserves low-frequency transients.
const SAMPLE_RATE = 1000;
const FRAME = 10;
const MAX_SECONDS = 3600;
const MAX_POINTS = 1000;
export interface BeatProposal { points: number[]; confidence: "low" | "moderate"; reason: string; duration: number; resolution_seconds: number }

/** Transient-derived candidate beats, not a claim of musical meter or exact tempo. */
export function estimateBeatCandidates(pcm: Buffer, duration: number): BeatProposal {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS || pcm.length % 2 !== 0) throw new UnprocessableError("Invalid decoded audio duration");
  const samples = pcm.length / 2;
  if (Math.abs(samples / SAMPLE_RATE - duration) > Math.max(0.25, duration * 0.02)) throw new UnprocessableError("Decoded audio duration differs from the measured duration");
  const energies: number[] = [];
  for (let start = 0; start + FRAME <= samples; start += FRAME) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) { const value = pcm.readInt16LE((start + i) * 2) / 32768; sum += value * value; }
    energies.push(Math.sqrt(sum / FRAME));
  }
  const scores = energies.map((energy, i) => Math.max(0, energy - (energies[i - 1] ?? 0)));
  const peak = scores.reduce((largest, value) => Math.max(largest, value), 0);
  if (peak < 0.002) return { points: [], confidence: "low", reason: "silent_or_too_quiet", duration, resolution_seconds: FRAME / SAMPLE_RATE };
  const candidates: { time: number; strength: number }[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < Math.max(0.002, peak * 0.2) || scores[i] < (scores[i - 1] ?? 0) || scores[i] <= (scores[i + 1] ?? 0)) continue;
    const candidate = { time: i * FRAME / SAMPLE_RATE, strength: scores[i] };
    const previous = candidates.at(-1);
    if (previous && candidate.time - previous.time < 0.2) { if (candidate.strength > previous.strength) candidates[candidates.length - 1] = candidate; }
    else candidates.push(candidate);
  }
  if (candidates.length > MAX_POINTS) return { points: [], confidence: "low", reason: "too_many_transients", duration, resolution_seconds: FRAME / SAMPLE_RATE };
  const gaps = candidates.slice(1).map((item, i) => item.time - candidates[i].time).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const regular = gaps.length >= 3 && median >= 0.25 && median <= 1.5 && gaps.every((gap) => Math.abs(gap - median) <= median * 0.15);
  return { points: candidates.map((item) => item.time), confidence: regular ? "moderate" : "low", reason: regular ? "regular_transients" : "irregular_or_sparse_transients", duration, resolution_seconds: FRAME / SAMPLE_RATE };
}

export async function analyzeMvBeats(bytes: Buffer, root: string, ffmpeg: string, ffprobe: string): Promise<BeatProposal> {
  const duration = await probeMvAudioDuration(bytes, root, ffprobe);
  const dir = mkdtempSync(join(root, ".mv-beats-"));
  try {
    writeFileSync(join(dir, "audio"), bytes, { flag: "wx" });
    let pcm: Buffer;
    try {
      const result = await promisify(execFile)(ffmpeg, ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", "audio", "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"], { cwd: dir, timeout: 60000, maxBuffer: MAX_SECONDS * SAMPLE_RATE * 2 + 65536, encoding: "buffer", windowsHide: true });
      pcm = result.stdout;
    } catch { throw new UnprocessableError("Unable to decode audio for beat estimation"); }
    return estimateBeatCandidates(pcm, duration);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
