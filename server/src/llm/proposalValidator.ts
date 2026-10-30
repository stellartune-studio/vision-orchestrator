import type { ItemView } from "@vo/shared";
import type { ProposalDraft } from "./provider.ts";

/** Bound on a document amendment body — same order as the request
 * body cap; oversized model output is rejected, never truncated. */
export const AMENDMENT_MAX_CHARS = 128_000;

/**
 * Server-side validation of a model-emitted document amendment. Only
 * a well-formed full body is accepted — the text is stored verbatim,
 * never repaired or silently clipped.
 */
export function validateAmendment(
  raw: unknown,
): { ok: true; content: string } | { ok: false; reason: string } {
  const content = (raw as { content?: unknown } | null)?.content;
  if (typeof content !== "string" || content.trim() === "") {
    return {
      ok: false,
      reason: "amendment content must be a non-empty string",
    };
  }
  if (content.length > AMENDMENT_MAX_CHARS) {
    return {
      ok: false,
      reason: `amendment exceeds the ${AMENDMENT_MAX_CHARS}-character limit`,
    };
  }
  return { ok: true, content };
}

/**
 * Server-side validation of LLM proposal drafts. A draft must name a
 * real project item (by id or unique label) and carry non-empty
 * content. Invalid drafts are reported, never saved — the blueprint
 * is never touched by malformed model output.
 */
export function validateProposals(
  drafts: unknown,
  items: ItemView[],
): {
  valid: { item_id: string; content: string; base_state_version: number }[];
  rejected: { reason: string; draft: unknown }[];
} {
  const valid: {
    item_id: string;
    content: string;
    base_state_version: number;
  }[] = [];
  const rejected: { reason: string; draft: unknown }[] = [];

  if (!Array.isArray(drafts)) {
    if (drafts !== undefined && drafts !== null) {
      rejected.push({ reason: "proposals must be an array", draft: drafts });
    }
    return { valid, rejected };
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  const byLabel = new Map<string, ItemView[]>();
  for (const i of items) {
    const list = byLabel.get(i.label) ?? [];
    list.push(i);
    byLabel.set(i.label, list);
  }

  for (const raw of drafts) {
    const d = raw as Partial<ProposalDraft>;
    let item: ItemView | undefined;
    if (typeof d.item_id === "string") {
      item = byId.get(d.item_id);
      if (!item) {
        rejected.push({ reason: `unknown item_id ${d.item_id}`, draft: raw });
        continue;
      }
    } else if (typeof d.item_label === "string") {
      const matches = byLabel.get(d.item_label) ?? [];
      if (matches.length !== 1) {
        rejected.push({
          reason:
            matches.length === 0
              ? `unknown item_label "${d.item_label}"`
              : `ambiguous item_label "${d.item_label}"`,
          draft: raw,
        });
        continue;
      }
      item = matches[0];
    } else {
      rejected.push({ reason: "proposal needs item_id or item_label", draft: raw });
      continue;
    }
    if (typeof d.content !== "string" || d.content.trim() === "") {
      rejected.push({ reason: "proposal content must be non-empty", draft: raw });
      continue;
    }
    valid.push({
      item_id: item.id,
      content: d.content,
      base_state_version: item.state_version,
    });
  }
  return { valid, rejected };
}
