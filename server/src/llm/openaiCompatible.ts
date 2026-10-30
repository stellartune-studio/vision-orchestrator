import type {
  DirectorInput,
  DirectorOutput,
  DirectorLLMProvider,
  DocAmendInput,
  DocAmendOutput,
  ProposalDraft,
} from "./provider.ts";
import { buildRevisionPrompt, buildSystemPrompt } from "./contextBuilder.ts";

/**
 * OpenAI-compatible Chat Completions client (plain fetch, no SDK).
 * Configured via env: OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY.
 * Text completions only in v1; structured output / tool calling is
 * enabled per-endpoint only after verification.
 *
 * Failure policy: errors propagate. There is NO silent fallback to
 * the mock — a real-endpoint failure must surface as a failure.
 */
export class OpenAiCompatibleProvider implements DirectorLLMProvider {
  readonly name = "openai-compatible";
  readonly isMock = false;

  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(baseUrl: string, model: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
  }

  async converse(input: DirectorInput): Promise<DirectorOutput> {
    const text = await this.chat([
      { role: "system", content: buildSystemPrompt(input) },
      ...input.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ]);
    const { reply, proposals } = parseReply(text);
    return { reply, proposals };
  }

  async reviseDocument(input: DocAmendInput): Promise<DocAmendOutput> {
    const res = await this.chat([
      { role: "system", content: buildRevisionPrompt(input) },
      ...input.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ]);
    return parseAmendReply(res);
  }

  private async chat(
    messages: { role: string; content: string }[],
  ): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, messages }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `LLM request failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

/** Split a reply into user-facing text and the ```json proposals block. */
export function parseReply(text: string): {
  reply: string;
  proposals: ProposalDraft[];
} {
  const match = /```json\s*([\s\S]*?)```/.exec(text);
  if (!match) return { reply: text.trim(), proposals: [] };
  const reply = text.replace(match[0], "").trim();
  try {
    const parsed = JSON.parse(match[1]) as { proposals?: ProposalDraft[] };
    return { reply, proposals: parsed.proposals ?? [] };
  } catch {
    return { reply: text.trim(), proposals: [] };
  }
}

/**
 * Split a revision-mode reply into user-facing text and the raw
 * amendment payload. The amendment is returned UNVALIDATED — the
 * caller runs it through validateAmendment before it may be saved, so
 * a malformed block is never mistaken for a stored draft.
 */
export function parseAmendReply(text: string): {
  reply: string;
  amendment?: unknown;
  amendment_error?: string;
} {
  const match = /```json\s*([\s\S]*?)```/.exec(text);
  if (!match) return { reply: text.trim() };
  const reply = text.replace(match[0], "").trim();
  let parsed: { amendment?: unknown };
  try {
    parsed = JSON.parse(match[1]) as { amendment?: unknown };
  } catch {
    // A fenced JSON block that does not parse is NOT a plain reply —
    // the model attempted an amendment and failed to encode it.
    return {
      reply,
      amendment_error: "amendment block is not valid JSON",
    };
  }
  if (parsed?.amendment === undefined) {
    return {
      reply,
      amendment_error: "json block contained no amendment field",
    };
  }
  return { reply, amendment: parsed.amendment };
}
