import type { WorkflowSelection } from "@vo/shared";
import { selectedGraph } from "./workflowSelection.ts";

/** Availability, scalar limits and standard link types; architecture/custom types still need execution. */
export function workflowCatalogIssues(selection: WorkflowSelection, catalog: Record<string, any>, settings?: Record<string, unknown>, referenceProvided = false): string[] {
  const issues: string[] = [];
  const graph = selectedGraph(selection, settings);
  const standardTypes = new Set(["MODEL", "CLIP", "VAE", "IMAGE", "MASK", "LATENT", "CONDITIONING", "NOISE", "SAMPLER", "SIGMAS", "GUIDER", "STRING", "BOOLEAN"]);
  for (const [id, node] of Object.entries(graph)) {
    const schema = catalog[String(node.class_type)];
    if (!schema) { issues.push(`${id}: node ${String(node.class_type)} is not registered`); continue; }
    const definitions = { ...schema.input?.required, ...schema.input?.optional };
    for (const [parent, definition] of Object.entries(definitions) as [string, any][]) {
      if (definition[0] !== "COMFY_DYNAMICCOMBO_V3") continue;
      const selected = definition[1]?.options?.find((option: any) => option.key === node.inputs[parent]);
      for (const [child, def] of Object.entries({ ...selected?.inputs?.required, ...selected?.inputs?.optional })) definitions[`${parent}.${child}`] = def;
    }
    for (const [key, value] of Object.entries(node.inputs)) {
      // The SDK replaces this filename with the already ownership-validated project asset.
      if (referenceProvided && id === selection.reference?.node && key === selection.reference.input) continue;
      const definition = definitions[key];
      if (!definition) continue;
      if (Array.isArray(value)) {
        const source = graph[String(value[0])];
        const sourceType = source && catalog[String(source.class_type)]?.output?.[Number(value[1])];
        const targetType = definition[0];
        if (standardTypes.has(sourceType) && standardTypes.has(targetType) && sourceType !== targetType) issues.push(`${id}.${key}: incompatible link ${sourceType} → ${targetType}`);
        continue;
      }
      const rawChoices = Array.isArray(definition[0]) ? definition[0] : definition[1]?.options;
      const choices = definition[0] === "COMFY_DYNAMICCOMBO_V3" && Array.isArray(rawChoices) ? rawChoices.map((option: any) => option.key) : rawChoices;
      if (Array.isArray(choices) && !choices.includes(value)) issues.push(`${id}.${key}: selected value is unavailable: ${String(value)}`);
      const limits = definition[1];
      if (typeof value === "number" && ((typeof limits?.min === "number" && value < limits.min) || (typeof limits?.max === "number" && value > limits.max))) issues.push(`${id}.${key}: numeric value is outside registered limits`);
    }
  }
  return issues;
}
