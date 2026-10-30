import type {
  DirectorInput,
  DirectorOutput,
  DirectorLLMProvider,
  DocAmendInput,
  DocAmendOutput,
  ProposalDraft,
} from "./provider.ts";

/**
 * Deterministic offline provider. Same contract as the real provider;
 * lets the full consult→propose→approve→save→resume flow be tested
 * with zero network. The UI must show the mock badge while active.
 */
export class MockDirectorProvider implements DirectorLLMProvider {
  readonly name = "mock";
  readonly isMock = true;

  async converse(input: DirectorInput): Promise<DirectorOutput> {
    const last = input.messages.at(-1)?.content ?? "";
    const proposals: ProposalDraft[] = [];

    const purpose = input.items.find(
      (i) => i.kind === "purpose" && i.adoption !== "adopted",
    );
    if (purpose) {
      const content = /物語|ストーリー|story/i.test(last)
        ? "Narrative (a story-driven video for an audience)"
        : /紹介|説明|解説/i.test(last)
          ? "Intro & explainer (a video that presents something clearly)"
          : "Personal viewing (a video for yourself)";
      proposals.push({ item_id: purpose.id, content });
    }

    const intent = input.items.find(
      (i) => i.kind === "intent" && i.adoption === "undecided",
    );
    if (intent && last) {
      proposals.push({
        item_id: intent.id,
        content: `Around "${last.slice(0, 60)}" as its core that leaves a lingering impression`,
      });
    }

    // output_policy is required by the production gate; without a mock
    // proposal the offline path dead-ends at a hidden manual field.
    const outputPolicy = input.items.find(
      (i) => i.kind === "output_policy" && i.adoption === "undecided",
    );
    if (outputPolicy && last) {
      proposals.push({
        item_id: outputPolicy.id,
        content: /縦|ショート|short|9:16/i.test(last)
          ? "9:16, one short scene (a few seconds), for social sharing"
          : "16:9, one short scene (a few seconds), for personal viewing",
      });
    }

    // Propose contents for up to two undecided story segments once a
    // narrative template has been applied.
    const segments = input.items.filter(
      (i) => i.kind === "story_segment" && i.adoption === "undecided",
    );
    if (purpose && /物語/.test(last)) {
      // purpose not yet adopted — hold segment proposals
    } else {
      for (const seg of segments.slice(0, 2)) {
        proposals.push({
          item_id: seg.id,
          content: `${seg.label}: ${last.slice(0, 40)} (draft scene)`,
        });
      }
    }

    const reply =
      proposals.length > 0
        ? [
            `Thanks for the consultation. I added ${proposals.length} proposals to the blueprint.`,
            `Please review them and decide whether to adopt.`,
            `(mock reply: a deterministic answer to "${last.slice(0, 40)}")`,
          ].join("\n")
        : `Noted: "${last.slice(0, 40)}". There are no new proposals right now. (mock reply)`;

    return { reply, proposals };
  }

  /**
   * Deterministic amendment: appends a marked edit note carrying the
   * directive to the base body. Keeps the base text verbatim so the
   * saved-revision/provenance path can be exercised end to end.
   */
  async reviseDocument(input: DocAmendInput): Promise<DocAmendOutput> {
    const instr = input.instruction.trim().slice(0, 120);
    const label =
      input.document.title ||
      (input.document.kind === "script" ? "script" : "storyboard");
    return {
      reply: [
        `${label}  amendment (based on rev #${input.document.base_rev_no}) was drafted.`,
        `It appends the instruction "${instr}" at the end. Please review and decide whether to approve.`,
        `(mock reply: not a real revision)`,
      ].join("\n"),
      amendment: {
        content: `${input.document.base_content}\n\n(amendment: ${instr})`,
      },
    };
  }
}
