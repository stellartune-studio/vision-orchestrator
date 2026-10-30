/** Explicit dry inspection: real SDK Workflow, intercepted before any remote submission. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Comfy } from "@comfyorg/sdk";
import { ComfySdkBackend } from "../gen/comfySdkBackend.ts";
import { parseWorkflowSelection } from "../gen/workflowSelection.ts";
import type { GenerationInput } from "../gen/backend.ts";

const root = resolve(import.meta.dirname, "../../../runtime/real-path-evidence");
const selection = parseWorkflowSelection(JSON.parse(readFileSync(resolve(root, "lora-selection.json"), "utf8")));
process.env.COMFY_BASE_URL = "http://127.0.0.1:8289";
const sdk = new Comfy();
let payload: unknown;
sdk.submit = async (workflow) => { payload = structuredClone(workflow.json); throw new Error("INSPECTION_ONLY_NO_SUBMIT"); };
const backend = new ComfySdkBackend({ base: { file: "unused", prompt_node: "unused", output_node: "unused" } }, root, async () => sdk);
const input: GenerationInput = {
  kind: "image", prompt: "Payload inspection only. No model execution.", ref_images: [], settings: { workflow_selection: selection },
  resolved_refs: { blueprint_version_id: "inspection-only", item_revision_ids: [], character_revision_ids: [], base_image_asset_ids: [], ref_image_asset_ids: [], asset_ids: [], used_asset_ids: [] },
};
try { await backend.submit(input, { project_id: "inspection-only", generation_id: "inspection-only" }); }
catch (error) { if (!(error instanceof Error) || error.message !== "INSPECTION_ONLY_NO_SUBMIT") throw error; }
if (!payload) throw new Error("SDK payload not captured");
const nodes = payload as Record<string, { inputs: Record<string, unknown> }>;
const lora = nodes["30_15"].inputs;
if (lora.lora_name !== "krea2_style_reference.safetensors" || lora.strength_model !== 0.7) throw new Error("LoRA payload mismatch");
writeFileSync(resolve(root, "lora-sdk-payload.json"), JSON.stringify({ submitted: false, sdk_workflow: payload, lora_values: lora, limit: "Real SDK Workflow.json verified; LoRA weights were not loaded and this graph was not remotely submitted" }, null, 2));
console.log("PASS real SDK LoRA payload inspection; no submission or weight loading");
