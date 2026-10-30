import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const QWEN_IMAGE_EDIT_PROFILE_ID =
  "qwen-image-2.1-turbo-edit-single" as const;
export const QWEN_IMAGE_EDIT_PROFILE_VERSION = "1" as const;
export const QWEN_IMAGE_EDIT_WORKFLOW_SHA256 =
  "9F5480090EDF7E0BCBC391DED0F9F702C2DA297875EC307CDAE40D17A0EF7B15" as const;
export const QWEN_IMAGE_EDIT_DEFAULT_SEED = 891836227295375;
export const QWEN_IMAGE_EDIT_RESOLUTION = 0;

export type ApiNode = {
  class_type?: unknown;
  inputs?: Record<string, unknown>;
};
export type ApiGraph = Record<string, ApiNode>;

export interface QwenWorkflowInfo {
  graph: ApiGraph;
  sha256: string;
  model_files: { role: string; file: string }[];
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function requireNode(
  graph: ApiGraph,
  id: string,
  classType: string,
  fields: string[],
): ApiNode {
  const node = graph[id];
  if (!record(node) || node.class_type !== classType || !record(node.inputs)) {
    throw new Error(`Qwen workflow node ${id} must be ${classType} with inputs`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(node.inputs, field)) {
      throw new Error(`Qwen workflow node ${id} is missing input ${field}`);
    }
  }
  return node;
}

export function validateQwenWorkflowGraph(value: unknown): ApiGraph {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.prompt)) {
    throw new Error('Qwen smoke workflow must be a single "prompt" envelope');
  }
  const graph = value.prompt as ApiGraph;
  const image = requireNode(graph, "1", "LoadImage", ["image"]);
  const unet = requireNode(graph, "2", "UNETLoader", ["unet_name", "weight_dtype"]);
  const clip = requireNode(graph, "3", "CLIPLoader", ["clip_name", "type", "device"]);
  const vae = requireNode(graph, "4", "VAELoader", ["vae_name"]);
  const text = requireNode(graph, "6", "TextEncodeQwenImage21", [
    "prompt", "resolution", "negative_prompt", "images.image_1", "clip", "vae",
  ]);
  const noise = requireNode(graph, "7", "RandomNoise", ["noise_seed"]);
  const decode = requireNode(graph, "12", "VAEDecode", ["samples", "vae"]);
  const output = requireNode(graph, "13", "SaveImage", ["images", "filename_prefix"]);
  if (image.inputs?.image !== "synthetic_red_barrier.png") {
    throw new Error("Qwen workflow source input is not the pinned LoadImage field");
  }
  if (JSON.stringify(text.inputs?.["images.image_1"]) !== JSON.stringify(["1", 0])) {
    throw new Error("Qwen edit image input is not linked from LoadImage node 1");
  }
  if (typeof text.inputs?.prompt !== "string" || text.inputs.prompt.length === 0) {
    throw new Error("Qwen workflow prompt input must be a non-empty string");
  }
  if (text.inputs?.resolution !== QWEN_IMAGE_EDIT_RESOLUTION) {
    throw new Error("Qwen workflow resolution input does not match the pinned profile");
  }
  if (text.inputs?.negative_prompt !== "") {
    throw new Error("Qwen profile requires an empty fixed negative prompt");
  }
  if (typeof noise.inputs?.noise_seed !== "number" || !Number.isSafeInteger(noise.inputs.noise_seed)) {
    throw new Error("Qwen workflow seed input must be a safe integer");
  }
  if (JSON.stringify(output.inputs?.images) !== JSON.stringify(["12", 0])) {
    throw new Error("Qwen output node 13 is not connected to decoder node 12");
  }
  if (typeof output.inputs?.filename_prefix !== "string") {
    throw new Error("Qwen output prefix must be a string");
  }
  const modelFiles = [
    { role: "diffusion", file: unet.inputs?.unet_name },
    { role: "text_encoder", file: clip.inputs?.clip_name },
    { role: "vae", file: vae.inputs?.vae_name },
  ];
  for (const model of modelFiles) {
    if (typeof model.file !== "string" || model.file.length === 0) {
      throw new Error(`Qwen workflow ${model.role} file is missing`);
    }
  }
  // Keep the decoder in the structural contract even though its input value
  // may be a Comfy link object; it is the source consumed by SaveImage.
  if (!record(decode.inputs)) throw new Error("Qwen decoder inputs are malformed");
  return graph;
}

export function readQwenWorkflowFile(
  file: string,
  expectedSha256: string = QWEN_IMAGE_EDIT_WORKFLOW_SHA256,
): QwenWorkflowInfo {
  const raw = readFileSync(file, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex").toUpperCase();
  if (sha256 !== expectedSha256.toUpperCase()) {
    throw new Error(
      `Qwen workflow SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Qwen workflow file is not valid JSON");
  }
  const graph = validateQwenWorkflowGraph(parsed);
  const modelFiles = [
    { role: "diffusion", file: String(graph["2"].inputs!.unet_name) },
    { role: "text_encoder", file: String(graph["3"].inputs!.clip_name) },
    { role: "vae", file: String(graph["4"].inputs!.vae_name) },
  ];
  return { graph, sha256, model_files: modelFiles };
}
