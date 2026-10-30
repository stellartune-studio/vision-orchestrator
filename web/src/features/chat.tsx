import { Fragment, useEffect, useRef, useState } from "react";
import type {
  AmendmentOutcome,
  DocumentView,
  ItemView,
  Message,
  Project,
  ProposalStatus,
} from "@vo/shared";
import { api } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";

const SUGGESTIONS = ["chat.example.story", "chat.example.promo", "chat.example.personal"];

// Status of a saved amendment TODAY — judged by the document's current
// adopted pointer first, then the revision's own status. "adopted" on a
// revision that is no longer the pointer means "approved earlier", not
// a revoked approval — the save-time fact stays separate either way.
function currentStatus(doc: DocumentView | undefined, rev: { id: string; proposal_status: ProposalStatus }, t: (key: string) => string): string {
  if (doc?.adopted_revision_id === rev.id) return t("content.status.currentlyAdopted");
  switch (rev.proposal_status) {
    case "adopted": return t("content.status.previouslyAdopted");
    case "dismissed": return t("content.status.dismissed");
    case "superseded": return t("content.status.superseded");
    default: return t("content.status.pending");
  }
}

/** The document revision the next instruction amends — resolved by
 *  the caller from live state, so the banner always shows truth. */
export interface AmendTarget {
  revisionId: string;
  documentId: string;
  docTitle: string;
  docKind: "script" | "storyboard";
  revNo: number;
  blueprintVersionNo: number | null;
}

// "Start from an idea" messages already attempted — module-level so a
// pane switch (which unmounts this panel) can never resend one, and a
// reload can't either (the set lives only in memory).
const autoSentIdeas = new Set<string>();

export function ChatPanel(props: {
  project: Project;
  messages: Message[];
  adoptedItems: ItemView[];
  pendingCount: number;
  /** revision id the user asked to amend but which no longer exists
   *  in live state — rendered as a stale banner, never re-targeted */
  amendTarget: AmendTarget | null;
  amendTargetStale: boolean;
  /** The idea typed on the home screen — sent automatically once as
   *  the first consultation so a new work opens mid-conversation.
   *  Present only until messages exist; never re-sent. */
  initialMessage?: string | null;
  /** Durable per-directive results — the ONLY source of truth for
   *  whether an amendment was stored. A directive with no row stays
   *  "unknown"; nothing is inferred from the reply text. */
  outcomes: AmendmentOutcome[];
  documents: DocumentView[];
  onClearAmendTarget: () => void;
  /** jump to the base↔result comparison for this outcome — the caller
   *  navigates to the document and focuses THAT pair, never another */
  onOpenDocument: (outcome: AmendmentOutcome) => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
  onOpenReview: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Synchronous guard: `sending` only takes effect after a re-render,
  // so a same-tick Enter+click pair would otherwise double-send.
  const inFlight = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  // What the server actually recorded per directive — keyed to the
  // assistant reply so each past instruction shows its own result.
  const outcomeByReply = new Map(
    props.outcomes.map((o) => [o.assistant_message_id, o]),
  );
  const revisionById = new Map(
    props.documents.flatMap((d) => d.revisions.map((r) => [r.id, r])),
  );
  const docById = new Map(props.documents.map((d) => [d.id, d]));

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages.length, sending]);

  // Auto-send the home-screen idea exactly once per project. The text
  // also fills the draft first: if the send fails, it stays editable
  // and a manual retry is one click away.
  useEffect(() => {
    const msg = props.initialMessage?.trim();
    if (!msg || props.messages.length > 0) return;
    const key = `${props.project.id}:${msg}`;
    if (autoSentIdeas.has(key)) return;
    autoSentIdeas.add(key);
    setDraft(msg);
    void send(msg);
  }, [props.initialMessage]);

  const send = async (override?: string) => {
    // Freeze the instruction and its target at send time — the text
    // that leaves is what the user saw when they pressed send.
    const content = (override ?? draft).trim();
    const targetRev = props.amendTarget?.revisionId;
    const staleTarget = props.amendTargetStale;
    // A stale target blocks outright — never silently downgraded to a
    // normal consultation; the user picks again or clears it.
    if (!content || inFlight.current || staleTarget) return;
    inFlight.current = true;
    setSending(true);
    try {
      await api.sendMessage(props.project.id, content, targetRev);
      // Only the sent text may be cleared — anything typed after the
      // request left stays in the box.
      setDraft((cur) => (cur.trim() === content ? "" : cur));
      // The result badge comes from the persisted outcome record that
      // the refresh below loads — never from the reply text.
      await props.onChanged();
    } catch (e) {
      props.onError(e);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const target = props.amendTarget;

  return (
    <div className="chat-wrap">
      <div className="pane-head">
        <h2>{t("chat.title")}</h2>
        <p className="muted">
          {t("chat.intro")}
        </p>
      </div>

      {target && (
        <div className="notice" role="status">
          <div>
            {t("chat.amendTarget")}{" "}
            <strong>
              {target.docTitle || t(`content.doc.${target.docKind}`)}
              {target.docTitle && ` (${t(`content.doc.${target.docKind}`)})`}
            </strong>{" "}
            {t("chat.baseRevision", { version: target.revNo })}
            {target.blueprintVersionNo != null &&
              ` ${t("content.fromBlueprint", { version: target.blueprintVersionNo })}`}
            <div className="muted small">
              {t("chat.amendTargetHint")}
            </div>
          </div>
          <button
            className="ghost"
            disabled={sending}
            onClick={props.onClearAmendTarget}
          >
            {t("chat.clearTarget")}
          </button>
        </div>
      )}
      {props.amendTargetStale && !target && (
        <div className="notice warn" role="alert">
          <div>
            {t("chat.staleTarget")}
          </div>
          <button
            className="ghost"
            disabled={sending}
            onClick={props.onClearAmendTarget}
          >
            {t("chat.clearTarget")}
          </button>
        </div>
      )}

      {props.adoptedItems.length > 0 && (
        <details className="chat-context">
          <summary>
            {t("chat.adoptedContext", { count: props.adoptedItems.length })}
          </summary>
          <ul className="adopted-list">
            {props.adoptedItems.map((i) => (
              <li key={i.id}>
                <span className="muted">{t(`content.kind.${i.kind}`)}</span>{" "}
                <strong>{i.label}</strong>
                <div className="clamp">
                  {i.adopted_revision?.content ?? ""}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="chat-messages">
        {props.messages.length === 0 && !sending && (
          <div className="empty">
            <p>{t("chat.empty")}</p>
            <p className="muted">{t("chat.examples")}</p>
            <div className="chips">
              {SUGGESTIONS.map((key) => (
                <button
                  key={key}
                  className="chip"
                  onClick={() => setDraft(t(key))}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}
        {props.messages.map((m) => {
          const outcome = outcomeByReply.get(m.id);
          const savedRev = outcome?.result_revision_id
            ? revisionById.get(outcome.result_revision_id)
            : undefined;
          return (
            <Fragment key={m.id}>
              <div className={`msg ${m.role}`}>
                <div className="msg-meta">{t(`chat.role.${m.role}`)}</div>
                <div className="msg-body">{m.content}</div>
              </div>
              {outcome?.outcome === "saved" && savedRev && (
                <div className="notice">
                  {t("chat.savedRevision", { version: savedRev.rev_no })} ({t("chat.currentStatus")}: {" "}
                  {currentStatus(
                    docById.get(outcome.document_id),
                    savedRev,
                    t,
                  )}.
                  <button
                    className="link"
                    onClick={() => props.onOpenDocument(outcome)}
                  >
                    {t("chat.compareBeforeAfter")} →
                  </button>
                </div>
              )}
              {outcome?.outcome === "reply_only" && (
                <div className="notice">
                  {t("chat.replyOnly")}
                </div>
              )}
              {outcome?.outcome === "rejected" && (
                <div className="notice warn" role="alert">
                  {t("chat.rejected", { reason: outcome.reject_reason ?? t("chat.unknownReason") })}
                </div>
              )}
            </Fragment>
          );
        })}
        {sending && (
          <div className="msg assistant pending">
            <div className="msg-meta">{t("chat.role.assistant")}</div>
            <div className="msg-body muted">{t("chat.thinking")}</div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {props.pendingCount > 0 && (
        <div className="notice">
          {t("chat.pendingProposals", { count: props.pendingCount })}{" "}
          <button className="link" onClick={props.onOpenReview}>
            {t("chat.reviewProposals")} →
          </button>
        </div>
      )}

      <div className="chat-input">
        {target && (
          <div className="muted small">
            {t("chat.targetSummary", { title: target.docTitle || t(`content.doc.${target.docKind}`), version: target.revNo })}
          </div>
        )}
        <textarea
          placeholder={
            target
              ? t("chat.amendPlaceholder")
              : t("chat.placeholder")
          }
          value={draft}
          rows={2}
          readOnly={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="primary"
          disabled={sending || !draft.trim() || props.amendTargetStale}
          onClick={() => void send()}
        >
          {sending ? t("chat.sending") : t("chat.send")}
        </button>
      </div>
    </div>
  );
}
