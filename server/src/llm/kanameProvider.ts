import { spawn } from "node:child_process";
import type {
  DirectorInput,
  DirectorLLMProvider,
  DirectorOutput,
  DocAmendInput,
  DocAmendOutput,
} from "./provider.ts";
import { buildRevisionPrompt, buildSystemPrompt } from "./contextBuilder.ts";
import { parseAmendReply, parseReply } from "./openaiCompatible.ts";

/**
 * Kaname-backed director provider: invokes the locally installed,
 * already-authenticated `kaname` CLI with a dedicated no-tool agent
 * profile. Kaname owns provider/credential resolution — this code
 * never reads, copies, or configures credentials.
 *
 *   app → kaname run --agent <profile> --input-file - --json
 *       → Kaname → configured provider (e.g. chatgpt)
 *
 * Failure policy: non-zero exit / unparseable output throws; there is
 * no silent fallback to the mock provider.
 */
export class KanameDirectorProvider implements DirectorLLMProvider {
  readonly name = "kaname";
  readonly isMock = false;

  private bin: string;
  private agent: string;
  private cwd: string;
  private timeoutMs: number;

  constructor(options: {
    bin: string;
    agent: string;
    cwd: string;
    timeout_ms?: number;
  }) {
    this.bin = options.bin;
    this.agent = options.agent;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeout_ms ?? 120_000;
  }

  async converse(input: DirectorInput): Promise<DirectorOutput> {
    const system = buildSystemPrompt(input);
    const history = input.messages
      .map((m) => `${m.role === "user" ? "監督" : "assistant"}: ${m.content}`)
      .join("\n\n");
    const prompt = [
      system,
      "",
      "## Conversation so far",
      history || "(none)",
      "",
      "Reply to the director's latest message.",
    ].join("\n");

    const text = await this.run(prompt);
    const { reply, proposals } = parseReply(text);
    return { reply, proposals };
  }

  async reviseDocument(input: DocAmendInput): Promise<DocAmendOutput> {
    const history = input.messages
      .map((m) => `${m.role === "user" ? "監督" : "assistant"}: ${m.content}`)
      .join("\n\n");
    const prompt = [
      buildRevisionPrompt(input),
      "",
      "## Conversation so far",
      history || "(none)",
      "",
      "Produce the revised document body now.",
    ].join("\n");
    const text = await this.run(prompt);
    return parseAmendReply(text);
  }

  private run(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.bin,
        ["run", "--agent", this.agent, "--input-file", "-", "--json"],
        { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`kaname run timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`kaname spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `kaname run exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`,
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          const answer =
            parsed["answer"] ??
            parsed["reply"] ??
            parsed["output"] ??
            parsed["text"] ??
            parsed["content"];
          if (typeof answer === "string" && answer.trim() !== "") {
            resolve(answer);
            return;
          }
          // Unknown --json shape — fall back to the raw text so the
          // reply parser can still split prose/proposals.
          resolve(stdout);
        } catch {
          resolve(stdout);
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
