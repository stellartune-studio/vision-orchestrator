import { useEffect, useRef, useState } from "react";
import type {
  DocumentRevision,
  DocumentView,
  Message,
} from "@vo/shared";
import { api } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { adoptionBadgeClass } from "./labels.ts";

// Same survival rule for document edit drafts: keyed
// `${doc.id}:${baseRevId}`, so a failed save or a refresh-driven
// remount cannot drop text the director was still editing.
const docEditDrafts = new Map<string, string>();

export function DocumentCard(props: {
  doc: DocumentView;
  versionNoById: Map<string, number>;
  /** chat instruction lookup for amendment provenance */
  messagesById: Map<string, Message>;
  /** when set, show THIS base↔result comparison and focus it — a
   *  saved outcome's own pair, never an auto-picked substitute */
  focus?: { baseRevisionId: string; resultRevisionId: string } | null;
  onAmendWithAI: (revisionId: string) => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const { doc } = props;
  const [busy, setBusy] = useState(false);
  const focusRef = useRef<HTMLDivElement>(null);
  const focusBase = props.focus
    ? doc.revisions.find((r) => r.id === props.focus!.baseRevisionId)
    : undefined;
  const focusResult = props.focus
    ? doc.revisions.find((r) => r.id === props.focus!.resultRevisionId)
    : undefined;
  const focusInstr = focusResult?.instruction_message_id
    ? props.messagesById.get(focusResult.instruction_message_id)
    : undefined;
  useEffect(() => {
    if (props.focus) {
      focusRef.current?.scrollIntoView({ block: "start" });
    }
  }, [props.focus]);
  // busy is only visible after a re-render — a same-tick second click
  // could still double-submit, so the synchronous ref guards the door.
  const inFlight = useRef(false);
  // The revision this edit is based on; null = editor closed.
  const [base, setBase] = useState<DocumentRevision | null>(null);
  const [editText, setEditTextState] = useState("");
  const draftKey = base ? `${doc.id}:${base.id}` : null;

  const setEditText = (v: string) => {
    setEditTextState(v);
    if (draftKey) docEditDrafts.set(draftKey, v);
  };
  const startEdit = (r: DocumentRevision) => {
    const key = `${doc.id}:${r.id}`;
    setBase(r);
    setEditTextState(docEditDrafts.get(key) ?? r.content);
  };
  const closeEdit = () => {
    setBase(null);
    setEditTextState("");
  };

  const run = (fn: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    fn()
      .then(props.onChanged)
      .catch(props.onError)
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  const versionLabel = (bvId: string | null) => {
    if (!bvId) return "";
    const no = props.versionNoById.get(bvId);
    return no != null ? ` (${t("content.fromBlueprint", { version: no })})` : ` (${t("content.blueprintId", { id: bvId.slice(0, 8) })})`;
  };

  return (
    <div className="item">
      <div className="item-head">
        <span className="item-label">
          {doc.title || t(`content.doc.${doc.kind}`)}
          {doc.title && <span className="muted"> ({t(`content.doc.${doc.kind}`)})</span>}
        </span>
        <span
          key={doc.adoption}
          className={`badge badge-pop ${adoptionBadgeClass(doc.adoption)}`}
        >
          {doc.adoption === "adopted" ? t("content.approved") : t(`content.adoption.${doc.adoption}`)}
        </span>
        {doc.consistency === "needs_recheck" && (
          <span className="badge recheck">{t("content.recheck")}</span>
        )}
      </div>

      {doc.consistency === "needs_recheck" && (
        <p className="muted small">
          {t("content.driftWarning")}
        </p>
      )}

      {props.focus && focusBase && focusResult && (
        <div ref={focusRef} className="proposal">
          <div className="muted">
            {t("content.savedAmendmentCompare", { base: focusBase.rev_no, result: focusResult.rev_no })}
          </div>
          {focusInstr && (
            <p className="muted small">{t("content.instruction")}: {focusInstr.content}</p>
          )}
          <div className="item-content">
            <div className="muted small">
              {t("content.fullBaseVersion", { version: focusBase.rev_no })}
            </div>
            {focusBase.content}
          </div>
          <div className="item-content">
            <div className="muted small">
              {t("content.fullAmendmentVersion", { version: focusResult.rev_no })}
            </div>
            {focusResult.content}
          </div>
        </div>
      )}

      {doc.pending_proposals.map((r) => {
        const revById = new Map(doc.revisions.map((x) => [x.id, x]));
        const baseRev = r.base_revision_id
          ? revById.get(r.base_revision_id)
          : undefined;
        const instruction = r.instruction_message_id
          ? props.messagesById.get(r.instruction_message_id)
          : undefined;
        const isAmendment = r.base_revision_id != null;
        return (
          <div key={r.id} className="proposal">
            <div className="muted">
              {t("content.documentProposal", { version: r.rev_no, source: r.source === "llm" ? "AI" : t("content.you") })}
              {versionLabel(r.blueprint_version_id)}
            </div>
            {isAmendment ? (
              <>
                {instruction && (
                  <p className="muted small">
                    {t("content.instruction")}: {instruction.content}
                  </p>
                )}
                {baseRev && (
                  <div className="item-content">
                    <div className="muted small">
                      {t("content.fullBaseVersion", { version: baseRev.rev_no })}
                    </div>
                    {baseRev.content}
                  </div>
                )}
                <div className="item-content">
                  <div className="muted small">{t("content.fullAmendmentVersion", { version: r.rev_no })}</div>
                  {r.content}
                </div>
              </>
            ) : (
              <p className="item-content clamp-3">{r.content}</p>
            )}
            <div className="row">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(() => api.adoptDocument(doc.id, r.id, doc.state_version))
                }
              >
                {t("content.approve")}
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => props.onAmendWithAI(r.id)}
              >
                {t("content.consultThisVersion")}
              </button>
            </div>
          </div>
        );
      })}

      {doc.adopted_revision && (
        <>
          <p className="item-content adopted clamp-3">
            {doc.adopted_revision.content}
          </p>
          <div className="row">
            <button
              className="link"
              disabled={busy}
              onClick={() => props.onAmendWithAI(doc.adopted_revision!.id)}
            >
              {t("content.consultThisVersion")}
            </button>
          </div>
        </>
      )}

      {base && (
        <div className="proposal">
          <div className="muted">
            {t("content.editingFromVersion", { version: base.rev_no, source: base.source === "llm" ? "AI" : t("content.you") })}
            {versionLabel(base.blueprint_version_id)}
          </div>
          <textarea
            aria-label={t("content.documentAmendmentFull")}
            rows={12}
            value={editText}
            readOnly={busy}
            onChange={(e) => setEditText(e.target.value)}
            style={{ width: "100%" }}
          />
          {busy && (
            <p className="muted small">
              {t("content.editingPaused")}
            </p>
          )}
          <div className="row">
            <button
              className="primary"
              disabled={busy || !editText.trim()}
              onClick={() => {
                // Freeze exactly what gets sent: if anything was typed
                // after this request left, it stays in the draft and
                // the editor stays open — sent text is the only text
                // a successful save may clear.
                const sentText = editText;
                const sentBaseId = base.id;
                const key = draftKey;
                run(async () => {
                  await api.addDocumentRevision(
                    doc.id,
                    sentText,
                    sentBaseId,
                  );
                  if (!key || docEditDrafts.get(key) === sentText) {
                    if (key) docEditDrafts.delete(key);
                    closeEdit();
                  }
                });
              }}
            >
              {t("content.saveAmendment")}
            </button>
            <button className="ghost" disabled={busy} onClick={closeEdit}>
              {t("content.cancel")}
            </button>
          </div>
          <p className="muted small">
            {t("content.appendOnlyAmendmentHint")}
          </p>
        </div>
      )}

      <details className="subtle">
        <summary className="muted">
          {t("content.allVersions", { count: doc.revisions.length })}
        </summary>
        <div>
          {doc.revisions.map((r) => (
            <div
              key={r.id}
              className={r.proposal_status === "pending" ? "proposal" : ""}
              style={r.proposal_status === "pending" ? {} : { opacity: 0.7 }}
            >
              <div className="muted">
                #{r.rev_no} [{t(`content.status.${r.proposal_status}`)}]{" "}
                {r.source === "llm" ? "AI" : t("content.you")}
                {versionLabel(r.blueprint_version_id)}
              </div>
              <p className="item-content">{r.content}</p>
              <div className="row">
                <button
                  className="link"
                  disabled={busy}
                  onClick={() => startEdit(r)}
                >
                  {t("content.editFromVersion")}
                </button>
                <button
                  className="link"
                  disabled={busy}
                  onClick={() => props.onAmendWithAI(r.id)}
                >
                  {t("content.consultThisVersion")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
