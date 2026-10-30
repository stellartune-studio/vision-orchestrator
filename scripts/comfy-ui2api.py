#!/usr/bin/env python3
"""Convert ComfyUI UI-format workflow JSON to API (prompt) format.

Handles the current template serialization format:
- links in both array form  [id, origin_id, origin_slot, target_id,
  target_slot, type] and object form {id, origin_id, origin_slot,
  target_id, target_slot, type}
- widget values via widgets_values_named (fallback: positional
  widgets_values aligned to widget-bound inputs)
- embedded subgraph definitions under definitions.subgraphs, expanded
  recursively with namespaced ids "<instance>_<inner>"
- subgraph IO: inputNode id -10 (one output slot per declared input),
  outputNode id -20 (one input slot per declared output)
- bypassed nodes (mode 4): outputs resolve to the first same-typed
  linked input
- muted nodes (mode 2) and UI-only notes (MarkdownNote) are dropped

Usage:
    python comfy-ui2api.py <input_dir> <output_dir>
"""

import json
import sys
from pathlib import Path

SKIP_TYPES = {"MarkdownNote", "Note"}
INPUT_NODE_ID = -10
OUTPUT_NODE_ID = -20

# Widgets bound to inputs but never serialized by the frontend.
# ImageCompare.compare_view is required, dict-typed and ignored by execute().
DEFAULT_WIDGET_VALUES = {"compare_view": {}}

MODEL_EXTS = (".safetensors", ".gguf", ".pt", ".pth", ".ckpt", ".bin",
              ".onnx", ".sft")


class Converter:
    def __init__(self, workflow):
        self.prompt = {}
        self.warnings = []
        self.model_refs = []  # (api_node_id, input_name, value)
        self.defs = {sg["id"]: sg
                     for sg in workflow.get("definitions", {}).get("subgraphs", [])}

    @staticmethod
    def widget_value(node, name):
        named = node.get("widgets_values_named")
        if isinstance(named, dict) and name in named:
            return named[name]
        bound = [i["widget"]["name"] for i in node.get("inputs", [])
                 if isinstance(i.get("widget"), dict)]
        values = node.get("widgets_values")
        if isinstance(values, dict):
            return values.get(name)
        if isinstance(values, list) and name in bound:
            idx = bound.index(name)
            if idx < len(values):
                return values[idx]
        return None

    @staticmethod
    def link_source(link):
        if isinstance(link, list):
            return link[1], link[2]
        return link["origin_id"], link["origin_slot"]

    @staticmethod
    def link_target(link):
        if isinstance(link, list):
            return link[3], link[4]
        return link["target_id"], link["target_slot"]

    def build(self, nodes, links, prefix, outer_vals, out_count=0):
        """Emit the graph body into self.prompt under `prefix`.

        outer_vals: resolved source ([node_id, slot] or literal) per
        declared input slot when this body is a subgraph, else None.
        out_count: number of declared outputs for a subgraph body.
        Returns resolved sources per declared output when body is a
        subgraph, else None.
        """
        linksrc = {}
        linkdst = {}
        for l in links or []:
            lid = l[0] if isinstance(l, list) else l["id"]
            linksrc[lid] = self.link_source(l)
            linkdst[lid] = self.link_target(l)

        node_by_id = {n["id"]: n for n in nodes}
        resolved_out = {}   # node_id -> {slot: source}
        # Subgraph instances must be resolvable before any consumer asks
        # for their outputs, regardless of node list order.
        deferred = {n["id"]: n for n in nodes if n["type"] in self.defs}

        def resolve_src(origin_id, slot):
            if origin_id == INPUT_NODE_ID:
                if outer_vals is None or slot >= len(outer_vals):
                    self.warnings.append(
                        f"{prefix}: unbound subgraph input slot {slot}")
                    return None
                return outer_vals[slot]
            if origin_id in resolved_out:
                return resolved_out[origin_id].get(slot)
            if origin_id in deferred:
                expand_instance(deferred.pop(origin_id))
                return resolved_out[origin_id].get(slot)
            src = node_by_id.get(origin_id)
            if src is not None:
                if src.get("mode") == 4:
                    resolved_out[origin_id] = bypass_map(src)
                    return resolved_out[origin_id].get(slot)
                if src.get("mode") == 2 or src["type"] in SKIP_TYPES:
                    self.warnings.append(
                        f"{prefix}{origin_id} ({src['type']}): consumed "
                        "output of a skipped node")
                    return None
            return [f"{prefix}{origin_id}", slot]

        def bypass_map(node):
            ins = {i.get("type"): i for i in node.get("inputs", [])
                   if i.get("link") is not None}
            out = {}
            for k, o in enumerate(node.get("outputs", []) or []):
                m = ins.get(o.get("type"))
                if m is None:
                    self.warnings.append(
                        f"{prefix}{node['id']} ({node['type']}): bypassed "
                        f"output slot {k} ({o.get('type')}) has no matching "
                        "input")
                    out[k] = None
                else:
                    out[k] = resolve_src(*linksrc[m["link"]])
            return out

        def expand_instance(node):
            sg = self.defs[node["type"]]
            inst_inputs = node.get("inputs", [])
            vals = []
            for k, d in enumerate(sg.get("inputs", [])):
                cand = next((i for i in inst_inputs
                             if i.get("name") == d.get("name")), None)
                if cand is None and k < len(inst_inputs):
                    cand = inst_inputs[k]
                if cand is None:
                    vals.append(None)
                elif cand.get("link") is not None:
                    vals.append(resolve_src(*linksrc[cand["link"]]))
                elif isinstance(cand.get("widget"), dict):
                    v = self.widget_value(node, cand["widget"]["name"])
                    if v is None:
                        v = DEFAULT_WIDGET_VALUES.get(cand["widget"]["name"])
                    if isinstance(v, (list, tuple)):
                        v = {"__value__": list(v)}
                    vals.append(v)
                else:
                    vals.append(None)
            inner = self.build(sg.get("nodes", []), sg.get("links", []),
                               f"{prefix}{node['id']}_", vals,
                               len(sg.get("outputs", [])))
            resolved_out[node["id"]] = {
                k: v for k, v in enumerate(inner or [])}

        for n in nodes:
            mode = n.get("mode", 0)
            if n["type"] in self.defs:
                continue  # expanded lazily via resolve_src or below
            if mode == 2 or n["type"] in SKIP_TYPES:
                continue
            if mode == 4:
                resolved_out[n["id"]] = bypass_map(n)
                continue
            ins = {}
            for i in n.get("inputs", []):
                if i.get("link") is not None:
                    src = resolve_src(*linksrc[i["link"]])
                    if src is not None:
                        ins[i["name"]] = src
                elif isinstance(i.get("widget"), dict):
                    v = self.widget_value(n, i["widget"]["name"])
                    if v is None:
                        v = DEFAULT_WIDGET_VALUES.get(i["widget"]["name"])
                    if v is not None:
                        # Literal lists must be wrapped: a bare list is the
                        # API encoding for a link.
                        if isinstance(v, (list, tuple)):
                            v = {"__value__": list(v)}
                        ins[i["widget"]["name"]] = v
            self.prompt[f"{prefix}{n['id']}"] = {
                "class_type": n["type"], "inputs": ins}

        # Expand subgraph instances that were never consumed
        # (their side effects, e.g. output nodes, still matter).
        while deferred:
            nid = next(iter(deferred))
            expand_instance(deferred.pop(nid))

        if outer_vals is None:
            return None
        # Declared outputs: inner links targeting outputNode -20,
        # target_slot == declared output index.
        out_srcs = [None] * out_count
        for lid, (tid, tslot) in linkdst.items():
            if tid == OUTPUT_NODE_ID and tslot < out_count:
                out_srcs[tslot] = resolve_src(*linksrc[lid])
        return out_srcs


def convert(workflow, *, require_complete_widgets=True):
    if require_complete_widgets:
        bodies = [workflow] + workflow.get("definitions", {}).get("subgraphs", [])
        for body in bodies:
            for node in body.get("nodes", []):
                if node["type"] in SKIP_TYPES or node.get("mode") in (2, 4):
                    continue
                values = node.get("widgets_values")
                bound = [i for i in node.get("inputs", []) if isinstance(i.get("widget"), dict)]
                if isinstance(values, list) and len(values) > len(bound) and not isinstance(node.get("widgets_values_named"), dict):
                    raise ValueError(f"Node {node['id']} ({node['type']}): incomplete widget mapping; export API format or save normalized named widgets in ComfyUI. No processing defaults were guessed.")
    conv = Converter(workflow)
    conv.build(workflow.get("nodes", []), workflow.get("links", []), "", None)
    for nid, node in conv.prompt.items():
        for iname, v in node["inputs"].items():
            if isinstance(v, str) and v.endswith(MODEL_EXTS):
                conv.model_refs.append((nid, iname, v))
    return conv


def main():
    src_dir, dst_dir = Path(sys.argv[1]), Path(sys.argv[2])
    dst_dir.mkdir(parents=True, exist_ok=True)
    for f in sorted(src_dir.glob("*.json")):
        wf = json.loads(f.read_text(encoding="utf-8"))
        conv = convert(wf)
        out = dst_dir / f.name
        out.write_text(json.dumps(conv.prompt, indent=2, ensure_ascii=False),
                       encoding="utf-8")
        print(f"{f.name}: {len(conv.prompt)} api nodes, "
              f"{len(conv.model_refs)} model refs, "
              f"{len(conv.warnings)} warnings")
        for w in conv.warnings:
            print(f"   WARN {w}")


if __name__ == "__main__":
    main()
