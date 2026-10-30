import { useState } from "react";
import type {
  ItemView,
  Message,
  ProjectState,
  SceneInputDraftRecord,
} from "@vo/shared";
import { api } from "../api/client.ts";
import { ContentItemCard } from "./contentItemCard.tsx";
import { DocumentCard } from "./documentCard.tsx";
import { SceneDraftCard } from "./sceneDraftCard.tsx";
import { useI18n } from "../i18n.tsx";
import { KIND_ORDER } from "./labels.ts";

export type ContentTab = "items" | "docs";


export function ContentPanel(props: {
  state: ProjectState;
  tab: ContentTab;
  onTabChange: (t: ContentTab) => void;
  /** embed inside the studio side panel — the outer tab bar already
   *  labels and switches the content, so the pane head and inner tab
   *  nav are hidden to avoid doubled chrome */
  embedded?: boolean;
  /** a saved outcome's own pair to show — resolved inside the matching
   *  DocumentCard; documents without a match render unchanged */
  docFocus?: {
    documentId: string;
    baseRevisionId: string;
    resultRevisionId: string;
  } | null;
  onAmendWithAI: (docId: string, revisionId: string) => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const { state } = props;
  const [busy, setBusy] = useState(false);
  const [openedSceneDraft, setOpenedSceneDraft] =
    useState<SceneInputDraftRecord | null>(null);
  const [openingSceneDraftId, setOpeningSceneDraftId] = useState<string | null>(null);
  const [sceneDraftError, setSceneDraftError] = useState<string | null>(null);
  const items = [...state.items].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.seq - b.seq,
  );
  const review = items.filter((i) => i.pending_proposals.length > 0);
  const settled = items.filter((i) => i.pending_proposals.length === 0);
  const pendingDocs = state.documents.filter(
    (d) => d.pending_proposals.length > 0,
  );

  const grouped = new Map<string, ItemView[]>();
  for (const i of settled) {
    grouped.set(i.kind, [...(grouped.get(i.kind) ?? []), i]);
  }

  const bvs = state.blueprint_versions;
  const latest = bvs.at(-1);
  const versionNoById = new Map(bvs.map((v) => [v.id, v.version_no]));
  const messagesById = new Map(state.messages.map((m) => [m.id, m]));

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn()
      .then(props.onChanged)
      .catch(props.onError)
      .finally(() => setBusy(false));
  };

  const openSceneDraft = async (draftId: string) => {
    setOpeningSceneDraftId(draftId);
    setSceneDraftError(null);
    setOpenedSceneDraft(null);
    try {
      const record = await api.sceneInputDraft(state.project.id, draftId);
      if (
        record.project_id !== state.project.id ||
        record.id !== draftId ||
        record.snapshot.project_id !== state.project.id ||
        record.snapshot.digest !== record.digest
      ) {
        setSceneDraftError(t("content.invalidDraft"));
        return;
      }
      setOpenedSceneDraft(record);
    } catch {
      setSceneDraftError(t("content.loadDraftFailed"));
    } finally {
      setOpeningSceneDraftId(null);
    }
  };

  return (
    <div>
      {!props.embedded && (
        <div className="pane-head">
        <h2>{t("app.content")}</h2>
          <p className="muted">
            {t("content.intro")}
          </p>
        </div>
      )}

      {!props.embedded && (
      <nav className="tabs" role="tablist" aria-label={t("content.switchTabs")}>
        <button
          role="tab"
          aria-selected={props.tab === "items"}
          className={props.tab === "items" ? "tab active" : "tab"}
          onClick={() => props.onTabChange("items")}
        >
          {t("app.items")}
          {review.length > 0 && (
            <span className="count">
              {review.reduce((n, i) => n + i.pending_proposals.length, 0)}
            </span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={props.tab === "docs"}
          className={props.tab === "docs" ? "tab active" : "tab"}
          onClick={() => props.onTabChange("docs")}
        >
          {t("app.docs")}
          {pendingDocs.length > 0 && (
            <span className="count">
              {pendingDocs.reduce((n, d) => n + d.pending_proposals.length, 0)}
            </span>
          )}
        </button>
      </nav>
      )}

      {props.tab === "items" && (
        <>
          {review.length > 0 ? (
            <section className="section">
              <h3 className="group-title warn-text">
                {t("content.needsReview", { count: review.length })}
              </h3>
              {review.map((item) => (
                <ContentItemCard
                  key={item.id}
                  item={item}
                  highlight
                  onChanged={props.onChanged}
                  onError={props.onError}
                />
              ))}
            </section>
          ) : (
            <p className="muted">{t("content.noPending")}</p>
          )}

          {KIND_ORDER.map((kind) => {
            const list = grouped.get(kind);
            if (!list?.length) return null;
            return (
              <section key={kind} className="section">
                <h3 className="group-title">{t(`content.kind.${kind}`)}</h3>
                {list.map((item) => (
                  <ContentItemCard
                    key={item.id}
                    item={item}
                    onChanged={props.onChanged}
                    onError={props.onError}
                  />
                ))}
              </section>
            );
          })}
        </>
      )}

      {props.tab === "docs" && (
        <>
          <section className="card">
            <h3>{t("content.blueprintVersions")}</h3>
            {latest ? (
              <p className="muted">
                {t("content.latestVersion")} <strong>v{latest.version_no}</strong> ({latest.created_at})
              </p>
            ) : (
              <p className="muted">
                {t("content.noVersion")}
              </p>
            )}
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(() =>
                  api.createBlueprintVersion(props.state.project.id),
                )
              }
            >
              {t("content.freezeVersion")}
            </button>
            {latest && (
              <p className="muted small">
                {t("content.versionImmutable")}
              </p>
            )}
          </section>

          <section className="section">
            <h3 className="group-title">{t("content.documents")}</h3>
            {!latest && (
              <p className="muted">
                {t("content.needVersion")}
              </p>
            )}
            {latest && (
              <div className="row wrap">
                <button
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      api.createDocument(
                        props.state.project.id,
                        "script",
                        latest.id,
                      ),
                    )
                  }
                >
                  {t("content.createScript", { version: latest.version_no })}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      api.createDocument(
                        props.state.project.id,
                        "storyboard",
                        latest.id,
                      ),
                    )
                  }
                >
                  {t("content.createStoryboard")}
                </button>
              </div>
            )}
            {state.documents.length === 0 && latest && (
              <p className="muted">{t("content.noDocuments")}</p>
            )}
            {state.documents.map((d) => (
              <DocumentCard
                key={d.id}
                doc={d}
                versionNoById={versionNoById}
                messagesById={messagesById}
                focus={
                  props.docFocus?.documentId === d.id
                    ? {
                        baseRevisionId: props.docFocus.baseRevisionId,
                        resultRevisionId: props.docFocus.resultRevisionId,
                      }
                    : null
                }
                onAmendWithAI={(revId) => props.onAmendWithAI(d.id, revId)}
                onChanged={props.onChanged}
                onError={props.onError}
              />
            ))}
          </section>

          <section className="section">
            <h3 className="group-title">{t("content.savedDrafts")}</h3>
            <p className="muted small">
              {t("content.savedDraftsHint")}
            </p>
            {state.scene_input_drafts.length === 0 ? (
              <p className="muted">{t("content.noSavedDrafts")}</p>
            ) : (
              state.scene_input_drafts.map((saved) => {
                const doc = state.documents.find((d) => d.id === saved.document_id);
                const rev = doc?.revisions.find(
                  (r) => r.id === saved.document_revision_id,
                );
                const versionNo = versionNoById.get(saved.blueprint_version_id);
                return (
                  <div className="item" key={saved.id}>
                    <div className="item-head">
                      <span className="item-label">
                        {doc?.title || (doc ? t(`content.doc.${doc.kind}`) : saved.document_id)}
                      </span>
                      <span className="badge proposed">{t("content.savedUnapproved")}</span>
                    </div>
                    <p className="muted small">
                      {t("content.documentVersion", { version: rev?.rev_no ?? "?", blueprint: versionNo ?? "?" })}
                      <br />{t("content.savedAt")}: {saved.saved_at}
                    </p>
                    <button
                      disabled={openingSceneDraftId !== null}
                      onClick={() => void openSceneDraft(saved.id)}
                    >
                      {openingSceneDraftId === saved.id ? t("content.loading") : t("content.openSaved")}
                    </button>
                  </div>
                );
              })
            )}
            {sceneDraftError && <p className="warn-text small">{sceneDraftError}</p>}
            {openedSceneDraft && (
              <SceneDraftCard
                draft={openedSceneDraft.snapshot}
                state={state}
                saved={openedSceneDraft}
              />
            )}
          </section>

          {bvs.length > 0 && (
            <details className="card subtle">
              <summary>{t("content.blueprintHistory", { count: bvs.length })}</summary>
              <ul className="version-list">
                {bvs.map((v) => (
                  <li key={v.id}>
                    v{v.version_no}{" "}
                    <span className="muted">{v.created_at}</span>
                    {v.note && <span className="muted"> — {v.note}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
