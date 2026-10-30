import assert from "node:assert/strict";
import { test } from "node:test";
import { posterComposeArgs, validatePosterLayout } from "../src/gen/posterCompose.ts";

test("poster graph retains ordered still and looping motion regions", () => {
  const layout = { width: 768, height: 1344, fps: 24, duration: 4, layers: [
    { kind: "motion", x: 100, y: 200, width: 200, height: 200, loop_frames: 24 },
    { kind: "still", x: 120, y: 220, width: 100, height: 80 },
  ] };
  assert.deepEqual(validatePosterLayout(layout), layout);
  const args = posterComposeArgs(layout), graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /crop=200:200:100:200,trim=end_frame=24.*loop=loop=-1:size=24/);
  assert.match(graph, /\[base\]\[layer0\]overlay=100:200.*\[canvas0\]\[layer1\]overlay=120:220/);
  assert.equal(args[args.indexOf("-t") + 1], "4");
  assert.throws(() => validatePosterLayout({ ...layout, layers: [{ ...layout.layers[0], x: 700 }] }));
  assert.throws(() => validatePosterLayout({ ...layout, layers: [{ ...layout.layers[0], loop_frames: 10000 }] }));
  assert.throws(() => validatePosterLayout({ ...layout, layers: [{ ...layout.layers[1] }] }));
  assert.throws(() => validatePosterLayout({ ...layout, layers: [{ ...layout.layers[0], x: "0; injected" }] }));
});
import { execFileSync } from "node:child_process";

test("poster FFmpeg graph loops the motion and restores the still layer in front", () => {
  const layout = { width: 64, height: 64, fps: 4, duration: 2, layers: [
    { kind: "motion", x: 0, y: 0, width: 64, height: 64, loop_frames: 4 },
    { kind: "still", x: 0, y: 0, width: 16, height: 16 },
  ] };
  const args = posterComposeArgs(layout);
  const graph = args[args.indexOf("-filter_complex") + 1];
  const frames = execFileSync("ffmpeg", ["-v", "error", "-filter_complex_threads", "1", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=4:d=2", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=4:d=1", "-filter_complex", graph, "-map", "[canvas1]", "-t", "2", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1024 * 1024, windowsHide: true });
  const frameSize = 64 * 64 * 3;
  assert.equal(frames.length, 8 * frameSize);
  assert.deepEqual(frames.subarray(0, frameSize), frames.subarray(4 * frameSize, 5 * frameSize));
  assert.notDeepEqual(frames.subarray(0, frameSize), frames.subarray(frameSize, 2 * frameSize));
  const foreground = frames.subarray(0, 3);
  assert.ok(foreground[0] > 200 && foreground[1] < 30 && foreground[2] < 30);
});
