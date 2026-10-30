export async function environmentRequest<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? `HTTP ${response.status}`), { status: response.status });
  return result as T;
}

import type { EnvironmentCatalog } from "@vo/shared";
export type Catalog = EnvironmentCatalog;
type NodeSchema = { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } };

export function nodeInputSchema(node: unknown): NodeSchema["input"] {
  return node && typeof node === "object" && "input" in node ? (node as NodeSchema).input : undefined;
}

/** Comfy exposes both legacy [choices] and V3 ["COMBO", {options}] widgets. */
export function inputChoices(definition: unknown[] | undefined): string[] {
  const metadata = definition?.[1];
  const choices = Array.isArray(definition?.[0]) ? definition[0]
    : metadata && typeof metadata === "object" && "options" in metadata ? metadata.options : [];
  return Array.isArray(choices) ? choices.map((value) => definition?.[0] === "COMFY_DYNAMICCOMBO_V3" && value && typeof value === "object" && "key" in value ? value.key : value).filter((value): value is string => typeof value === "string") : [];
}
