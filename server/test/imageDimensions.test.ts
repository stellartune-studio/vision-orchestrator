import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { imageExifOrientation, probeImageDimensions } from "../src/gen/imageDimensions.ts";

test("EXIF orientation follows TIFF byte order and fails closed on truncation", () => {
  const bigEndian = Buffer.from("4578696600004d4d002a00000008000101120003000000010006000000000000", "hex");
  const littleEndian = Buffer.from("45786966000049492a0008000000010012010300010000000800000000000000", "hex");
  assert.equal(imageExifOrientation(bigEndian), 6);
  assert.equal(imageExifOrientation(littleEndian), 8);
  assert.equal(imageExifOrientation(Buffer.from("ordinary image")), null);
  assert.throws(() => imageExifOrientation(Buffer.from("4578696600004d4d002a", "hex")), /EXIF/);
});

test("image preflight rejects paths outside the asset root before invoking a probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-image-path-"));
  const root = join(dir, "assets");
  const outside = join(dir, "outside.png");
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(root); writeFileSync(outside, "outside");
    await assert.rejects(() => probeImageDimensions(outside, root, 1024), /outside managed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
