import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Asset } from "@vo/shared";
import { verifiedPromotionAsset } from "../src/gen/promotionAsset.ts";

test("promotion asset check enforces ownership, root, size and exact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "vo-promo-"));
  try {
    const file = join(root, "logo.png"); const bytes = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"); writeFileSync(file, bytes);
    const asset = { owner_kind: "project", owner_id: "p", mime: "image/png", path: file, sha256: createHash("sha256").update(bytes).digest("hex") } as Asset;
    assert.deepEqual(verifiedPromotionAsset(asset, "p", root, 100, "image/png"), bytes);
    assert.throws(() => verifiedPromotionAsset(asset, "other", root, 100, "image/png"));
    assert.throws(() => verifiedPromotionAsset(asset, "p", root, 2, "image/png"));
    assert.throws(() => verifiedPromotionAsset(asset, "p", join(root, ".."), 100, "video/mp4"));
    assert.throws(() => verifiedPromotionAsset({ ...asset, path: join(root, "..", "outside") }, "p", root, 100, "image/png"));
    const malformed = Buffer.from("not a PNG"); writeFileSync(file, malformed);
    assert.throws(() => verifiedPromotionAsset({ ...asset, sha256: createHash("sha256").update(malformed).digest("hex") }, "p", root, 100, "image/png"), /PNG header/);
    writeFileSync(file, "changed"); assert.throws(() => verifiedPromotionAsset(asset, "p", root, 100, "image/png"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
