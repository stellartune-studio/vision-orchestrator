import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  QWEN_IMAGE_EDIT_PROFILE_ID,
  readQwenWorkflowFile,
} from "./gen/qwenImageEditProfile.ts";
import {
  QWEN_IMAGE_T2I_PROFILE_ID,
  readQwenTextWorkflowFile,
} from "./gen/qwenImageTextProfile.ts";

export interface ServerConfig {
  port: number;
  /** Optional bind address; absent preserves the existing Node default. */
  host?: string;
  data_dir: string;
  db_path: string;
  assets_root: string;
  /** FFmpeg executable used for explicit local video edits. */
  ffmpeg_bin?: string;
  ffprobe_bin?: string;
  llm_provider: "mock" | "openai-compatible" | "kaname";
  openai?: { base_url: string; model: string; api_key?: string };
  kaname?: { bin: string; agent: string; cwd: string };
  gen_backend: "mock" | "comfy-sdk";
  workflow_file: string;
  /** max JSON request body size in bytes (covers base64 uploads) */
  max_body_bytes: number;
  /** optional img2img/reference workflow; enables ref_image capability */
  ref_workflow_file?: string;
  /** optional video workflow (Wan2.2 TI2V default, FastH3 i2v legacy);
   *  enables the "video" kind */
  video_workflow_file?: string;
  /** "default" uses the bundled Apache-2.0 graphs (MOSS image + Wan
   *  video); Qwen profiles remain legacy opt-ins. */
  gen_profile?: "default" | typeof QWEN_IMAGE_T2I_PROFILE_ID | typeof QWEN_IMAGE_EDIT_PROFILE_ID;
  qwen_t2i_workflow_file?: string;
  qwen_t2i_workflow?: ReturnType<typeof readQwenTextWorkflowFile>;
  qwen_workflow_file?: string;
  qwen_workflow?: ReturnType<typeof readQwenWorkflowFile>;
}

/**
 * Load server configuration from .env + environment. Secrets are
 * read here (server side) only — never bundled into the frontend,
 * logged, or included in project exports.
 */
export function loadConfig(projectRoot?: string): ServerConfig {
  const root = projectRoot ?? resolve(import.meta.dirname, "../..");
  const envFile = join(root, ".env");
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // malformed .env — rely on real environment
    }
  }

  const llm = process.env.LLM_PROVIDER ?? "mock";
  if (llm !== "mock" && llm !== "openai-compatible" && llm !== "kaname") {
    throw new Error(
      `LLM_PROVIDER must be "mock", "openai-compatible" or "kaname", got "${llm}"`,
    );
  }
  const gen = process.env.GEN_BACKEND ?? "mock";
  if (gen !== "mock" && gen !== "comfy-sdk") {
    throw new Error(`GEN_BACKEND must be "mock" or "comfy-sdk", got "${gen}"`);
  }
  // "default" is the Apache-2.0 MOSS/Wan path; Qwen profiles are
  // explicit legacy opt-ins and are never selected implicitly.
  const profile = process.env.GEN_PROFILE ?? "default";
  if (
    profile !== "default" &&
    profile !== QWEN_IMAGE_T2I_PROFILE_ID &&
    profile !== QWEN_IMAGE_EDIT_PROFILE_ID
  ) {
    throw new Error(
      `GEN_PROFILE must be "default", "${QWEN_IMAGE_T2I_PROFILE_ID}" or "${QWEN_IMAGE_EDIT_PROFILE_ID}", got "${profile}"`,
    );
  }
  if (profile !== "default" && gen !== "comfy-sdk") {
    throw new Error(`GEN_PROFILE=${profile} requires GEN_BACKEND=comfy-sdk`);
  }
  if (gen === "comfy-sdk" && process.env.COMFY_CHECKPOINT?.trim()) {
    throw new Error(
      "COMFY_CHECKPOINT is not supported by the pinned generation profiles (MOSS/Wan default or Qwen opt-in); remove it instead of substituting a checkpoint model",
    );
  }
  const qwenT2iWorkflowFile = profile === QWEN_IMAGE_T2I_PROFILE_ID
    ? resolve(import.meta.dirname, "gen/workflows/txt2img.json")
    : undefined;
  const qwenWorkflowFile = profile === QWEN_IMAGE_T2I_PROFILE_ID ||
      profile === QWEN_IMAGE_EDIT_PROFILE_ID
    ? resolve(
        process.env.COMFY_QWEN21_WORKFLOW ??
          process.env.COMFY_REF_WORKFLOW ??
          resolve(import.meta.dirname, "gen/workflows/qwen21_img2img.json"),
      )
    : undefined;
  // Pin graph bytes and node/model structure at startup so real Comfy
  // never silently falls back to a checkpoint-based SD workflow.
  const qwenT2iWorkflow = qwenT2iWorkflowFile
    ? readQwenTextWorkflowFile(qwenT2iWorkflowFile)
    : undefined;
  const qwenWorkflow = qwenWorkflowFile
    ? readQwenWorkflowFile(qwenWorkflowFile)
    : undefined;

  let openai: ServerConfig["openai"];
  if (llm === "openai-compatible") {
    const base_url = process.env.OPENAI_BASE_URL;
    const model = process.env.OPENAI_MODEL;
    if (!base_url || !model) {
      throw new Error(
        "LLM_PROVIDER=openai-compatible requires OPENAI_BASE_URL and OPENAI_MODEL",
      );
    }
    openai = {
      base_url,
      model,
      api_key: process.env.OPENAI_API_KEY,
    };
  }

  let kaname: ServerConfig["kaname"];
  if (llm === "kaname") {
    // The dedicated agent profile lives in the repo's .kaname/agents/;
    // Kaname resolves credentials itself — nothing secret here.
    kaname = {
      bin: process.env.KANAME_BIN ?? "kaname",
      agent: process.env.KANAME_AGENT ?? "vision-director",
      cwd: process.env.KANAME_WORKDIR ?? root,
    };
  }

  // VO_DATA_DIR lets a scratch instance run beside the real data dir
  // (verification on throwaway data). Defaults to <root>/data.
  const dataDir = process.env.VO_DATA_DIR
    ? resolve(process.env.VO_DATA_DIR)
    : join(root, "data");
  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST?.trim() || undefined,
    data_dir: dataDir,
    db_path: join(dataDir, "app.db"),
    assets_root: join(dataDir, "assets"),
    ffmpeg_bin: process.env.FFMPEG_BIN?.trim() || "ffmpeg",
    ffprobe_bin: process.env.FFPROBE_BIN?.trim() || "ffprobe",
    llm_provider: llm,
    openai,
    kaname,
    gen_backend: gen,
    gen_profile: profile,
    qwen_t2i_workflow_file: qwenT2iWorkflowFile,
    qwen_t2i_workflow: qwenT2iWorkflow,
    qwen_workflow_file: qwenWorkflowFile ? resolve(qwenWorkflowFile) : undefined,
    qwen_workflow: qwenWorkflow,
    max_body_bytes: (() => {
      const n = Number(process.env.MAX_BODY_BYTES);
      return Number.isFinite(n) && n > 0 ? n : 32 * 1024 * 1024;
    })(),
    workflow_file: resolve(
      import.meta.dirname,
      profile === "default"
        ? "gen/workflows/moss_txt2img.json"
        : "gen/workflows/txt2img.json",
    ),
    ref_workflow_file: profile === QWEN_IMAGE_T2I_PROFILE_ID
      ? qwenWorkflowFile
      : undefined,
    // Wan2.2-TI2V-5B is the shared default video graph for every
    // profile. FastH3 remains available by pointing COMFY_VIDEO_WORKFLOW
    // at fasth3_i2v.json; a missing override file disables video rather
    // than silently substituting another workflow.
    video_workflow_file: (() => {
      const p =
        process.env.COMFY_VIDEO_WORKFLOW ??
        resolve(import.meta.dirname, "gen/workflows/wan22_ti2v_i2v.json");
      return existsSync(p) ? p : undefined;
    })(),
  };
}
