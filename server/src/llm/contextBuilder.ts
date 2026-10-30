import type { DirectorInput, DocAmendInput } from "./provider.ts";

/**
 * Build the system prompt for the director LLM from DATABASE state —
 * approved content, unconfirmed proposals, undecided items and pinned
 * character constraints are passed as DISTINCT sections. The model
 * never reconstructs agreement state from a conversation summary.
 */
export function buildSystemPrompt(input: DirectorInput): string {
  const adopted = input.items.filter((i) => i.adopted_revision);
  const pending = input.items.filter((i) => i.pending_proposals.length > 0);
  const undecided = input.items.filter((i) => i.adoption === "undecided");

  const lines: string[] = [
    `You are the production assistant of "Vision Orchestrator" (制作設計図).`,
    `The user is the director (監督). You consult, propose, and wait for`,
    `approval. Never treat your own proposal as agreed.`,
    ``,
    `## Project: ${input.project_name}`,
    ``,
    `## Approved blueprint items (user-confirmed, do NOT overwrite)`,
  ];
  for (const i of adopted) {
    lines.push(
      `- [${i.kind}] ${i.label}: ${i.adopted_revision!.content}`,
    );
  }
  if (adopted.length === 0) lines.push(`- (none yet)`);

  lines.push(``, `## Unconfirmed proposals awaiting the user`);
  for (const i of pending) {
    for (const p of i.pending_proposals) {
      lines.push(`- [${i.kind}] ${i.label} proposal #${p.rev_no}: ${p.content}`);
    }
  }
  if (pending.length === 0) lines.push(`- (none)`);

  lines.push(``, `## Undecided items (propose or ask about these)`);
  for (const i of undecided) {
    lines.push(`- [${i.kind}] ${i.label} (item_id: ${i.id})`);
  }
  if (undecided.length === 0) lines.push(`- (none)`);

  lines.push(``, `## Characters pinned to this project`);
  for (const c of input.characters) {
    const traits = Object.entries(c.locked_traits)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(
      `- ${c.name} (locked: ${traits || "none"}; base image: ${c.has_base_image ? "yes" : "no"})`,
    );
  }
  if (input.characters.length === 0) lines.push(`- (none)`);

  lines.push(
    ``,
    `## How to propose blueprint changes`,
    `Reply to the user normally, then — ONLY if you have concrete`,
    `suggestions — append one fenced block:`,
    "```json",
    `{"proposals": [{"item_id": "<id>", "content": "<proposal text>"}]}`,
    "```",
    `Use item_id values from the undecided/pending sections above.`,
    `Proposals stay unconfirmed until the user approves them.`,
  );
  return lines.join("\n");
}

/**
 * System prompt for a document-revision directive. The edit base and
 * the production standards are passed as DISTINCT sections: the frozen
 * blueprint snapshot the base revision derives from is the
 * authoritative basis; live-state drift is listed separately and
 * flagged as informational only. The model gets content, never ids.
 */
export function buildRevisionPrompt(input: DocAmendInput): string {
  const d = input.document;
  const docLabel = d.title || (d.kind === "script" ? "台本" : "絵コンテ");
  const lines: string[] = [
    `You are the production assistant of "Vision Orchestrator" (制作設計図).`,
    `The user is the director (監督). They asked you to revise ONE`,
    `production document. Produce the full revised body plus a short`,
    `explanation. The result stays an unconfirmed proposal until the`,
    `director approves it — never claim it is adopted.`,
    ``,
    `## Project: ${input.project_name}`,
    ``,
    `## Document under revision`,
    `- document: ${docLabel} (${d.kind})`,
    `- base revision: #${d.base_rev_no} (status: ${d.base_status})`,
    ``,
    `## Base document body (edit this faithfully)`,
    d.base_content,
  ];

  if (input.frozen_context) {
    const fc = input.frozen_context;
    lines.push(
      ``,
      `## Production standards frozen in blueprint v${fc.version_no}`,
      `(the authoritative basis — do NOT treat as editable)`,
      `### Adopted blueprint items`,
    );
    for (const i of fc.items) {
      lines.push(`- [${i.kind}] ${i.label}: ${i.content}`);
    }
    if (fc.items.length === 0) lines.push(`- (none)`);
    lines.push(`### Fixed constraints (must be respected)`);
    for (const i of fc.fixed_constraints) {
      lines.push(`- ${i.label}: ${i.content}`);
    }
    if (fc.fixed_constraints.length === 0) lines.push(`- (none)`);
    lines.push(`### Pinned characters (locked traits)`);
    for (const ch of fc.characters) {
      const traits = Object.entries(ch.locked_traits)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(
        `- ${ch.name} (locked: ${traits || "none"}; base image: ${ch.has_base_image ? "yes" : "no"})`,
      );
    }
    if (fc.characters.length === 0) lines.push(`- (none)`);
  } else {
    lines.push(
      ``,
      `## Production standards`,
      `(the base revision has no blueprint link — no frozen standards)`,
    );
  }

  if (input.drift_notes.length > 0) {
    lines.push(
      ``,
      `## Differences vs the current working state`,
      `(informational only — NOT the basis for this revision)`,
    );
    for (const n of input.drift_notes) lines.push(`- ${n}`);
  }

  lines.push(
    ``,
    `## The director's revision directive`,
    input.instruction,
    ``,
    `## Rules`,
    `- Keep every part of the base body the directive does not touch.`,
    `- If the directive conflicts with fixed constraints or locked`,
    `  traits, say so in your reply and keep the standards intact —`,
    `  never silently rewrite them.`,
    `- Reply to the user first; then append exactly one block:`,
    "```json",
    `{"amendment": {"content": "<the FULL revised document body>"}}`,
    "```",
    `- amendment.content is the complete new body, not a diff or a`,
    `  description. No blueprint-item proposals in this mode.`,
  );
  return lines.join("\n");
}
