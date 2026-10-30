import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { MockDirectorProvider } from "./llm/mockProvider.ts";
import { OpenAiCompatibleProvider } from "./llm/openaiCompatible.ts";
import { KanameDirectorProvider } from "./llm/kanameProvider.ts";
import { MockGenerationBackend } from "./gen/mockBackend.ts";
import { ComfySdkBackend } from "./gen/comfySdkBackend.ts";
import { QWEN_IMAGE_T2I_PROFILE_ID } from "./gen/qwenImageTextProfile.ts";
import { buildRouter } from "./http/handlers.ts";

const config = loadConfig();
const db = openDatabase(config.db_path);
const applied = migrate(
  db,
  join(import.meta.dirname, "db/migrations"),
);
if (applied.length > 0) {
  console.log(`migrations applied: ${applied.join(", ")}`);
}

const llm =
  config.llm_provider === "openai-compatible"
    ? new OpenAiCompatibleProvider(
        config.openai!.base_url,
        config.openai!.model,
        config.openai!.api_key,
      )
    : config.llm_provider === "kaname"
      ? new KanameDirectorProvider({
          bin: config.kaname!.bin,
          agent: config.kaname!.agent,
          cwd: config.kaname!.cwd,
          timeout_ms: Number(process.env.KANAME_TIMEOUT_MS ?? 120_000),
        })
      : new MockDirectorProvider();

// Video bindings are keyed by the configured file's basename: the
// legacy FastH3 graph keeps its own bindings; every other video file
// (the Wan2.2-TI2V-5B default) uses the Wan bindings. Wan clip length
// is a frame count baked into node 55 — duration_seconds is never
// injected as a frame count on that path.
const videoSpec = (file: string) =>
  file.endsWith("fasth3_i2v.json")
    ? {
        // FastH3 i2v (API format exported from the official
        // template video_fastvideo_fasth3_i2v.json)
        file,
        prompt_node: "105:104",
        prompt_input: "prompt",
        seed_node: "105:15",
        seed_input: "noise_seed",
        output_node: "92",
        ref_image_node: "136",
        duration_node: "105:111",
        duration_input: "value",
        size_node: "142",
      }
    : {
        // Wan2.2-TI2V-5B i2v (API graph from the official Comfy
        // Wan2.2 5B TI2V template; low-VRAM defaults on node 55).
        file,
        prompt_node: "6",
        prompt_input: "text",
        seed_node: "3",
        seed_input: "seed",
        output_node: "58",
        ref_image_node: "56",
        ref_image_input: "image",
        size_node: "55",
        width_input: "width",
        height_input: "height",
      };

const gen =
  config.gen_backend === "comfy-sdk"
    ? config.gen_profile === "qwen-image-2.1-turbo-edit-single"
      ? new ComfySdkBackend(
          {
            base: {
              file: config.qwen_workflow_file!,
              graph: config.qwen_workflow!.graph,
              workflow_sha256: config.qwen_workflow!.sha256,
              profile_id: config.gen_profile,
              profile_version: "1",
              model_files: config.qwen_workflow!.model_files,
              prompt_node: "6",
              prompt_input: "prompt",
              seed_node: "7",
              seed_input: "noise_seed",
              output_node: "13",
              edit_source_node: "1",
              edit_source_input: "image",
              resolution_node: "6",
              resolution_input: "resolution",
              fixed_resolution: 0,
              negative_prompt_node: "6",
              negative_prompt_input: "negative_prompt",
              fixed_negative_prompt: "",
            },
          },
          config.assets_root,
        )
      : config.gen_profile === QWEN_IMAGE_T2I_PROFILE_ID
        ? new ComfySdkBackend(
          {
            base: {
              file: config.qwen_t2i_workflow_file!,
              graph: config.qwen_t2i_workflow!.graph,
              workflow_sha256: config.qwen_t2i_workflow!.sha256,
              profile_id: QWEN_IMAGE_T2I_PROFILE_ID,
              profile_version: "1",
              model_files: config.qwen_t2i_workflow!.model_files,
              prompt_node: "6",
              prompt_input: "prompt",
              negative_node: "6",
              negative_input: "negative_prompt",
              seed_node: "7",
              seed_input: "noise_seed",
              output_node: "14",
              size_node: "11",
              width_input: "width",
              height_input: "height",
              // Node 11 (LatentCrop) works in half-pixel space: requested
              // dims × 0.5 decode to exactly the requested pixels. Verified
              // on real ComfyUI 2026-10-26: 1280x720 request → 640x360 crop
              // → 1280x720 PNG (23s); scale 1.0 overshoots to 2048x1440
              // (~43s). Do not "fix" this to 1.0.
              size_scale: 0.5,
            },
            ref: config.qwen_workflow_file && config.qwen_workflow
              ? {
                  file: config.qwen_workflow_file,
                  graph: config.qwen_workflow.graph,
                  workflow_sha256: config.qwen_workflow.sha256,
                  profile_id: "qwen-image-2.1-turbo-reference-edit",
                  profile_version: "1",
                  model_files: config.qwen_workflow.model_files,
                  prompt_node: "6",
                  prompt_input: "prompt",
                  negative_node: "6",
                  negative_input: "negative_prompt",
                  seed_node: "7",
                  seed_input: "noise_seed",
                  output_node: "13",
                  ref_image_node: "1",
                  ref_image_input: "image",
                  resolution_node: "6",
                  resolution_input: "resolution",
                  resolution_from_output_area: true,
                }
              : undefined,
            video: config.video_workflow_file
              ? videoSpec(config.video_workflow_file)
              : undefined,
          },
          config.assets_root,
          )
        : new ComfySdkBackend(
          {
            // Default path: MOSS-Image SFT INT8 txt2img (Apache-2.0).
            // Prompt is the raw request text on the PrimitiveString
            // node; the graph's own rewriter branch stays untouched.
            base: {
              file: config.workflow_file,
              prompt_node: "18_17",
              prompt_input: "value",
              negative_node: "18_5",
              negative_input: "text",
              seed_node: "18_7",
              seed_input: "seed",
              output_node: "9",
              size_node: "18_6",
              width_input: "width",
              height_input: "height",
              size_scale: 1,
            },
            video: config.video_workflow_file
              ? videoSpec(config.video_workflow_file)
              : undefined,
          },
          config.assets_root,
          )
    : new MockGenerationBackend(config.assets_root);

const router = buildRouter({ db, config, llm, gen });

const server = createServer((req, res) => {
  router.handle(req, res).catch((err) => {
    console.error("unhandled request error", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    } else {
      res.end();
    }
  });
});
server.on("close", () => router.close());

server.listen(config.port, config.host, () => {
  console.log(
    `vision-orchestrator server on :${config.port} ` +
      `(llm=${llm.name}${llm.isMock ? " MOCK" : ""}, ` +
      `gen=${gen.name}${gen.isMock ? " MOCK" : ""}, db=${config.db_path})`,
  );
});
