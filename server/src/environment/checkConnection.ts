/** Read-only official SDK handshake and workflow inventory audit. No submission. */
import { Comfy } from "@comfyorg/sdk";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { planEnvironment } from "./setupService.ts";

const plan = planEnvironment("managed");
const get = async (path: string) => {
  const response = await fetch(plan.comfy_url + path, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
};
const stats = await get("/system_stats");
const nodes = await get("/object_info");
process.env.COMFY_BASE_URL = plan.proxy_url;
const client = new Comfy();
let observedJobs = 0;
for await (const _job of client.listJobs({ limit: 1 })) { observedJobs++; break; }
const source = resolve(plan.root, "../../../vendor/ComfyUI/ComfyUI/user/default/workflows");
const copies = resolve(plan.root, "user/default/workflows");
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const originals = existsSync(source) ? readdirSync(source).filter((f) => f.endsWith(".json")).map((file) => ({ file, source_sha256: hash(resolve(source, file)), copy_matches: existsSync(resolve(copies, file)) && hash(resolve(source, file)) === hash(resolve(copies, file)) })) : [];
const apiRoot = resolve(plan.root, "workflows-api");
const workflows = readdirSync(apiRoot).filter((f) => f.endsWith(".json")).map((file) => {
  const graph = JSON.parse(readFileSync(resolve(apiRoot, file), "utf8")) as Record<string, any>;
  const missingNodes: string[] = [];
  const unavailableModels: string[] = [];
  for (const node of Object.values(graph)) {
    const schema = nodes[node.class_type];
    if (!schema) { missingNodes.push(node.class_type); continue; }
    const definitions = { ...schema.input?.required, ...schema.input?.optional };
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !/\.(safetensors|gguf|pt|pth|ckpt|bin|onnx|sft)$/i.test(value)) continue;
      const definition = definitions[key];
      const choices = Array.isArray(definition?.[0]) ? definition[0] : definition?.[1]?.options;
      if (Array.isArray(choices) && !choices.includes(value)) unavailableModels.push(`${node.class_type}.${key}: ${value}`);
    }
  }
  return { file, api_nodes: Object.keys(graph).length, missing_nodes: [...new Set(missingNodes)], unavailable_models: [...new Set(unavailableModels)], generation_verified: false };
});
const report = { captured_at: new Date().toISOString(), comfy_url: plan.comfy_url, proxy_url: plan.proxy_url, upstream_revision: plan.revision, comfy_version: stats.system?.comfyui_version, pytorch_version: stats.system?.pytorch_version, device: stats.devices?.[0]?.name, registered_nodes: Object.keys(nodes).length, sdk_list_jobs: "passed (read-only)", observed_jobs: observedJobs, originals, workflows, gpu_generation: "not run", model_loading: "not run", custom_nodes_installed: [] };
writeFileSync(resolve(plan.root, "connection-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
