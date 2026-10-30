import { useState } from "react";
import type { ItemView } from "@vo/shared";
import { api } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { adoptionBadgeClass } from "./labels.ts";

// A pending-proposal draft must survive a re-render that moves the card
// between sections (e.g. a 409 conflict refresh re-homes the item from
// 要確認 into its kind group, remounting the component and dropping
// local state). Keyed by item id, cleared on successful submit.
const revisionDrafts = new Map<string, string>();

export function ContentItemCard(props: {
  item: ItemView;
  highlight?: boolean;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const { item } = props;
  const [draft, setDraftState] = useState(
    () => revisionDrafts.get(item.id) ?? "",
  );
  const [busy, setBusy] = useState(false);

  const setDraft = (v: string) => {
    setDraftState(v);
    if (v) revisionDrafts.set(item.id, v);
    else revisionDrafts.delete(item.id);
  };

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn()
      .then(props.onChanged)
      .catch(props.onError)
      .finally(() => setBusy(false));
  };

  return (
    <div className={props.highlight ? "item highlight" : "item"}>
      <div className="item-head">
        <span className="item-label">{item.label}</span>
        <span
          // keyed by value: an adoption change remounts the badge so
          // its pop animation replays — "adopted" visibly lands
          key={item.adoption}
          className={`badge badge-pop ${adoptionBadgeClass(item.adoption)}`}
        >
          {t(`content.adoption.${item.adoption}`)}
        </span>
        {item.stale_proposal_count > 0 && (
          <span className="badge stale">{t("content.staleCount", { count: item.stale_proposal_count })}</span>
        )}
      </div>

      {item.adopted_revision ? (
        <p className="item-content adopted clamp-3">
          {item.adopted_revision.content}
        </p>
      ) : (
        <p className="item-content empty-slot">{t("content.notAdopted")}</p>
      )}

      {item.pending_proposals.map((p) => {
        const stale = p.base_state_version !== item.state_version;
        return (
          <div key={p.id} className={stale ? "proposal stale" : "proposal"}>
            <div className="muted">
              {t("content.proposalMeta", { version: p.rev_no, source: p.source === "llm" ? "AI" : t("content.you") })}
              {stale && ` — ${t("content.staleProposal")}`}
            </div>
            <p className="item-content">{p.content}</p>
            <div className="row">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(() => api.adopt(item.id, p.id, item.state_version))
                }
              >
                {t("content.adopt")}
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  run(() => api.dismiss(item.id, p.id, item.state_version))
                }
              >
                {t("content.dismiss")}
              </button>
            </div>
          </div>
        );
      })}

      <details className="subtle">
        <summary className="muted">
          {t("content.editAndHistory", { count: item.revisions.length })}
        </summary>
        <div className="row">
          <input
            placeholder={t("content.writeYourOwn")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            disabled={busy || !draft.trim()}
            onClick={() =>
              run(async () => {
                await api.addRevision(item.id, draft.trim());
                setDraft("");
              })
            }
          >
            {t("content.addProposal")}
          </button>
        </div>
        {item.revisions.length > 0 && (
          <div className="revision-history">
            {item.revisions.map((r) => (
              <div key={r.id}>
                #{r.rev_no} [{t(`content.status.${r.proposal_status}`)}]{" "}
                {r.source === "llm" ? "AI" : t("content.you")}:{" "}
                {r.content.slice(0, 80)}
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
