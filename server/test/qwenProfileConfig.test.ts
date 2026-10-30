import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const keys = [
  "GEN_BACKEND", "GEN_PROFILE", "COMFY_QWEN21_WORKFLOW", "COMFY_REF_WORKFLOW",
  "COMFY_CHECKPOINT", "COMFY_VIDEO_WORKFLOW", "VO_DATA_DIR", "HOST",
] as const;

function withCleanConfigEnv(action: () => void): void {
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    action();
  } finally {
    for (const key of keys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Qwen profile remains opt-in and preserves the existing mock default", () => {
  withCleanConfigEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "vo-qwen-config-default-"));
    try {
      const config = loadConfig(dir);
      assert.equal(config.gen_backend, "mock");
      assert.equal(config.gen_profile, "default");
      assert.equal(config.qwen_workflow, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("Qwen profiles require the real Comfy SDK backend", () => {
  withCleanConfigEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "vo-qwen-config-required-"));
    try {
      process.env.GEN_PROFILE = "qwen-image-2.1-turbo-edit-single";
      assert.throws(() => loadConfig(dir), /requires GEN_BACKEND=comfy-sdk/);
      process.env.GEN_BACKEND = "comfy-sdk";
      const config = loadConfig(dir);
      assert.equal(config.qwen_workflow?.model_files.length, 3);
      assert.equal(config.qwen_workflow_file?.endsWith("qwen21_img2img.json"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("real Comfy defaults to the Apache MOSS image and Wan video workflows", () => {
  withCleanConfigEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "vo-moss-config-default-"));
    try {
      process.env.GEN_BACKEND = "comfy-sdk";
      const config = loadConfig(dir);
      assert.equal(config.gen_profile, "default");
      assert.equal(config.workflow_file.endsWith("moss_txt2img.json"), true);
      assert.equal(config.video_workflow_file?.endsWith("wan22_ti2v_i2v.json"), true);
      assert.equal(config.qwen_t2i_workflow, undefined);
      assert.equal(config.qwen_t2i_workflow_file, undefined);
      assert.equal(config.qwen_workflow, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("Qwen profiles stay legacy opt-ins and keep the pinned graph checks", () => {
  withCleanConfigEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "vo-qwen-config-t2i-"));
    try {
      process.env.GEN_BACKEND = "comfy-sdk";
      process.env.GEN_PROFILE = "qwen-image-2.1-turbo";
      const config = loadConfig(dir);
      assert.equal(config.gen_profile, "qwen-image-2.1-turbo");
      assert.equal(config.qwen_t2i_workflow?.model_files.length, 3);
      assert.equal(config.qwen_t2i_workflow_file?.endsWith("txt2img.json"), true);
      assert.equal(config.qwen_workflow?.model_files.length, 3);
      assert.equal(config.video_workflow_file?.endsWith("wan22_ti2v_i2v.json"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("legacy default profile setting cannot route real generation back to SD", () => {
  withCleanConfigEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "vo-qwen-config-legacy-default-"));
    try {
      process.env.GEN_BACKEND = "comfy-sdk";
      process.env.GEN_PROFILE = "default";
      const config = loadConfig(dir);
      assert.equal(config.gen_profile, "default");
      assert.equal(config.workflow_file.endsWith("moss_txt2img.json"), true);
      process.env.COMFY_CHECKPOINT = "v1-5-pruned-emaonly-fp16.safetensors";
      assert.throws(() => loadConfig(dir), /COMFY_CHECKPOINT is not supported/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("default MOSS and Wan workflow files exist and parse as API graphs", () => {
  for (const name of ["moss_txt2img.json", "wan22_ti2v_i2v.json"]) {
    const file = join(import.meta.dirname, "../src/gen/workflows", name);
    assert.equal(existsSync(file), true, `${name} missing`);
    const graph = JSON.parse(readFileSync(file, "utf8")) as Record<string, { class_type?: string }>;
    assert.ok(Object.values(graph).every((node) => typeof node.class_type === "string"), `${name} is not an API-format graph`);
  }
});

test("Qwen profile rejects a different local graph instead of falling back", () => {
  withCleanConfigEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "vo-qwen-config-mismatch-"));
    try {
      const file = join(dir, "other-graph.json");
      const configRoot = join(dir, "config");
      mkdirSync(configRoot);
      writeFileSync(file, JSON.stringify({ prompt: {} }));
      process.env.GEN_BACKEND = "comfy-sdk";
      process.env.GEN_PROFILE = "qwen-image-2.1-turbo-edit-single";
      process.env.COMFY_QWEN21_WORKFLOW = file;
      assert.throws(() => loadConfig(configRoot), /SHA-256 mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Binding is operational configuration; leave the historical default unchanged.
test("HOST opts into a bind address without changing the absent default", () => {
  withCleanConfigEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "vo-host-config-"));
    try {
      assert.equal(loadConfig(dir).host, undefined);
      process.env.HOST = "127.0.0.1";
      assert.equal(loadConfig(dir).host, "127.0.0.1");
      process.env.HOST = "  ";
      assert.equal(loadConfig(dir).host, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
