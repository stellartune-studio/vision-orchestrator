import type { WorkflowSelection } from "@vo/shared";
import { BadRequestError } from "../repos/errors.ts";

/** API graphs only. Editor canvas conversion remains an explicit offline operation. */
export function parseWorkflowSelection(value: unknown): WorkflowSelection {
  const fail = (message: string): never => { throw new BadRequestError(message); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("selection must be an object");
  const s = value as WorkflowSelection;
  if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 200) return fail("workflow name required (max 200)");
  if (s.kind !== "image" && s.kind !== "video") return fail("invalid workflow kind");
  if (!s.graph || typeof s.graph !== "object" || Array.isArray(s.graph) || !Object.keys(s.graph).length || Object.keys(s.graph).length > 2000) return fail("API graph required (max 2000 nodes)");
  for (const [id, node] of Object.entries(s.graph)) {
    if (!id || !node || typeof node.class_type !== "string" || !node.class_type || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) return fail("invalid API node");
    for (const v of Object.values(node.inputs)) {
      if (Array.isArray(v)) {
        if (v.length !== 2 || typeof v[0] !== "string" || !Number.isInteger(v[1]) || v[1] < 0 || !Object.hasOwn(s.graph, v[0])) return fail("invalid graph link");
      } else if (!(typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) return fail("unsupported input value");
    }
  }
  const binding = (b: { node: string; input: string } | undefined) => {
    if (!b || typeof b.node !== "string" || typeof b.input !== "string" || !Object.hasOwn(s.graph, b.node) || !Object.hasOwn(s.graph[b.node].inputs, b.input)) return fail("binding must name an existing node input");
    if (Array.isArray(s.graph[b.node].inputs[b.input])) return fail("binding cannot replace a graph link");
  };
  if (s.prompt_verbatim !== undefined && typeof s.prompt_verbatim !== "boolean") return fail("prompt_verbatim must be boolean");
  if (s.source !== undefined) {
    if (!s.source || typeof s.source !== "object" || Array.isArray(s.source) || typeof s.source.url !== "string" || s.source.url.length > 2000 || typeof s.source.revision !== "string" || !s.source.revision || s.source.revision.length > 200 || !/^[a-f0-9]{64}$/.test(s.source.source_sha256) || !/^[a-f0-9]{64}$/.test(s.source.api_sha256)) return fail("invalid workflow source metadata");
    try { const url = new URL(s.source.url); if (url.protocol !== "https:" || url.username || url.password) return fail("source must be a public HTTPS URL"); } catch { return fail("invalid workflow source URL"); }
  }
  binding(s.prompt);
  if (typeof s.graph[s.prompt.node].inputs[s.prompt.input] !== "string") return fail("prompt input must be text");
  if (typeof s.output_node !== "string" || !Object.hasOwn(s.graph, s.output_node)) return fail("output node missing");
  if (s.reference) binding(s.reference);
  const targets = new Set([`${s.prompt.node}\0${s.prompt.input}`, ...(s.reference ? [`${s.reference.node}\0${s.reference.input}`] : [])]);
  if (s.settings !== undefined && (!s.settings || typeof s.settings !== "object" || Array.isArray(s.settings))) return fail("invalid settings bindings");
  for (const [key, target] of Object.entries(s.settings ?? {})) {
    if (!["width", "height", "seed", "duration_seconds"].includes(key)) return fail("unknown setting binding");
    binding(target);
    const id = `${target.node}\0${target.input}`;
    if (targets.has(id) || typeof s.graph[target.node].inputs[target.input] !== "number" || (target.scale !== undefined && (!Number.isFinite(target.scale) || target.scale <= 0))) return fail("invalid numeric setting binding");
    targets.add(id);
  }
  if (!Array.isArray(s.values) || s.values.length > 4000) return fail("values must be an array (max 4000)");
  const seen = new Set<string>();
  for (const v of s.values) {
    binding(v);
    const key = `${v.node}\0${v.input}`;
    if (seen.has(key) || (v.node === s.prompt.node && v.input === s.prompt.input) || (s.reference && v.node === s.reference.node && v.input === s.reference.input)) return fail("duplicate or reserved input override");
    seen.add(key);
    if (typeof v.value !== typeof s.graph[v.node].inputs[v.input] || !(typeof v.value === "string" || typeof v.value === "boolean" || (typeof v.value === "number" && Number.isFinite(v.value)))) return fail("input override type mismatch");
  }
  // Retain only the public contract, never arbitrary properties from a request.
  return structuredClone({ name: s.name, kind: s.kind, graph: s.graph, ...(s.source ? { source: { url: s.source.url, revision: s.source.revision, source_sha256: s.source.source_sha256, api_sha256: s.source.api_sha256 } } : {}), prompt: s.prompt, ...(s.prompt_verbatim !== undefined ? { prompt_verbatim: s.prompt_verbatim } : {}), output_node: s.output_node, reference: s.reference, settings: s.settings, values: s.values });
}

export function selectedGraph(selection: WorkflowSelection, settings?: Record<string, unknown>) {
  const graph = structuredClone(selection.graph);
  for (const value of selection.values) graph[value.node].inputs[value.input] = value.value;
  for (const [key, target] of Object.entries(selection.settings ?? {})) {
    const value = settings?.[key];
    if (typeof value === "number") graph[target.node].inputs[target.input] = value * (target.scale ?? 1);
  }
  return graph;
}
