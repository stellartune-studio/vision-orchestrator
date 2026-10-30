import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ApiGraph } from "./qwenImageEditProfile.ts";

export const QWEN_IMAGE_T2I_PROFILE_ID =
  "qwen-image-2.1-turbo" as const;
export const QWEN_IMAGE_T2I_PROFILE_VERSION = "1" as const;
export const QWEN_IMAGE_T2I_WORKFLOW_SHA256 =
  "DEF11AC51EC0B8FBD7461EED459FBE8B4864C5D9D3622842AC2666AB0A63D63A" as const;

export interface QwenTextWorkflowInfo {
  graph: ApiGraph;
  sha256: string;
  model_files: { role: string; file: string }[];
}

const asRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function requireNode(
  graph: ApiGraph,
  id: string,
  classType: string,
  fields: string[],
): ApiGraph[string] {
  const node = graph[id];
  if (!asRecord(node) || node.class_type !== classType || !asRecord(node.inputs)) {
    throw new Error(`Qwen text workflow node ${id} must be ${classType} with inputs`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(node.inputs, field)) {
      throw new Error(`Qwen text workflow node ${id} is missing input ${field}`);
    }
  }
  return node;
}

export function validateQwenTextWorkflow(value: unknown): ApiGraph {
  if (!asRecord(value) || Object.hasOwn(value, "prompt")) {
    throw new Error("Qwen text workflow must be a flat API graph");
  }
  const graph = value as ApiGraph;
  const unet = requireNode(graph, "2", "UNETLoader", ["unet_name", "weight_dtype"]);
  const clip = requireNode(graph, "3", "CLIPLoader", ["clip_name", "type", "device"]);
  const vae = requireNode(graph, "4", "VAELoader", ["vae_name"]);
  requireNode(graph, "5", "QwenImage21Cache", ["model", "dtype", "device"]);
  const text = requireNode(graph, "6", "TextEncodeQwenImage21", [
    "prompt", "negative_prompt", "resolution", "clip", "vae",
  ]);
  const noise = requireNode(graph, "7", "RandomNoise", ["noise_seed"]);
  requireNode(graph, "11", "LatentCrop", ["samples", "width", "height", "x", "y"]);
  requireNode(graph, "12", "SamplerCustomAdvanced", ["latent_image", "sampler", "sigmas", "noise", "guider"]);
  requireNode(graph, "13", "VAEDecode", ["samples", "vae"]);
  const output = requireNode(graph, "14", "SaveImage", ["images", "filename_prefix"]);

  if (typeof unet.inputs?.unet_name !== "string" ||
      !unet.inputs.unet_name.includes("qwen_image_2.1_turbo")) {
    throw new Error("Qwen text workflow must use the pinned Qwen Image 2.1 Turbo diffusion model");
  }
  if (clip.inputs?.clip_name !== "qwen3vl_8b_int8_convrot.safetensors" ||
      clip.inputs?.type !== "qwen_image") {
    throw new Error("Qwen text workflow must use the pinned Qwen3-VL 8B image encoder");
  }
  if (vae.inputs?.vae_name !== "qwen_image_2.1_vae_bf16.safetensors") {
    throw new Error("Qwen text workflow must use the pinned Qwen Image 2.1 VAE");
  }
  if (text.inputs?.resolution !== 2048 || Object.hasOwn(text.inputs, "images.image_1")) {
    throw new Error("Qwen text workflow must be text-only and use the pinned 2048 latent canvas");
  }
  if (JSON.stringify(text.inputs?.["clip"]) !== JSON.stringify(["3", 0]) ||
      JSON.stringify(text.inputs?.["vae"]) !== JSON.stringify(["4", 0]) ||
      JSON.stringify(output.inputs?.images) !== JSON.stringify(["13", 0])) {
    throw new Error("Qwen text workflow model or output links do not match the pinned graph");
  }
  if (typeof text.inputs?.prompt !== "string" || text.inputs.prompt.length === 0 ||
      typeof noise.inputs?.noise_seed !== "number" || !Number.isSafeInteger(noise.inputs.noise_seed)) {
    throw new Error("Qwen text workflow prompt and seed inputs are malformed");
  }
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type === "CheckpointLoaderSimple" || node.class_type === "CLIPTextEncode") {
      throw new Error(`Qwen text workflow node ${id} is an unsupported checkpoint-based fallback`);
    }
  }
  return graph;
}

export function readQwenTextWorkflowFile(
  file: string,
  expectedSha256: string = QWEN_IMAGE_T2I_WORKFLOW_SHA256,
): QwenTextWorkflowInfo {
  const raw = readFileSync(file, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex").toUpperCase();
  if (sha256 !== expectedSha256.toUpperCase()) {
    throw new Error(`Qwen text workflow SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Qwen text workflow file is not valid JSON");
  }
  const graph = validateQwenTextWorkflow(parsed);
  return {
    graph,
    sha256,
    model_files: [
      { role: "diffusion", file: String(graph["2"].inputs!.unet_name) },
      { role: "text_encoder", file: String(graph["3"].inputs!.clip_name) },
      { role: "vae", file: String(graph["4"].inputs!.vae_name) },
    ],
  };
}
