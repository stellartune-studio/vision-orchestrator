import type { ProjectState, SceneInputDraft, SceneInputDraftRecord } from "@vo/shared";
import { useI18n } from "../i18n.tsx";
import { SceneDraftReviewPanel } from "./sceneDraftReview.tsx";

const CHECK_STATUS_LABEL: Record<
  SceneInputDraft["open_questions"][number]["status"],
  string
> = {
  related_text_found: "sceneDraft.question.related",
  none_found: "sceneDraft.question.noneFound",
  not_inspected: "sceneDraft.question.notInspected",
};

export function SceneDraftCard(props: {
  draft: SceneInputDraft;
  state: ProjectState;
  saved?: SceneInputDraftRecord | null;
  saving?: boolean;
  onSave?: () => void;
}) {
  const { t } = useI18n();
  const { draft } = props;
  const doc = props.state.documents.find((d) => d.id === draft.document_id);
  const docLabel = doc
    ? doc.title || t(`content.doc.${doc.kind}`)
    : draft.document_id.slice(0, 8);
  const currentRevision = doc?.revisions.find(
    (r) => r.id === doc.adopted_revision_id,
  );
  const currentBlueprintNo = currentRevision?.blueprint_version_id
    ? props.state.blueprint_versions.find(
        (v) => v.id === currentRevision.blueprint_version_id,
      )?.version_no
    : null;
  const srcList = (sources: SceneInputDraft["scene"]["sources"]) =>
    sources.map((s) => s.label ?? s.id.slice(0, 8)).join(" ／ ");
  const sectionList = (sections: SceneInputDraft["context"]) => (
    <ul className="check-list">
      {sections.map((c, i) => (
        <li key={i} className="check">
          <span>{c.content}</span>
          <div className="muted small">{t("sceneDraft.source", { sources: srcList(c.sources) })}</div>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="scene-draft">
      <p>
        {props.saved ? (
          <>
            <span className="badge proposed">{t("sceneDraft.savedUnapproved")}</span>{" "}
            <span className="muted small">
              {t("sceneDraft.savedMeta", { id: props.saved.id, date: props.saved.saved_at })}
              <br />
              {t("sceneDraft.savedNotInput")}
            </span>
          </>
        ) : (
          <>
            <span className="badge proposed">{t("sceneDraft.unsavedUnapproved")}</span>{" "}
            <span className="muted small">
              {t("sceneDraft.previewOnly")}
            </span>
          </>
        )}
      </p>
      <p className="muted small">
        {t(props.saved ? "sceneDraft.savedTarget" : "sceneDraft.target")}: {docLabel} {t("sceneDraft.documentVersion", { version: draft.document_rev_no })} ／ {t("sceneDraft.blueprintVersion", { version: draft.blueprint_version_no })}
        {props.saved && currentRevision && (
          <>
            <br />
            {t("sceneDraft.currentAdopted", { documentVersion: currentRevision.rev_no, blueprintVersion: currentBlueprintNo ?? "?" })}
            {currentRevision.id !== draft.document_revision_id && (
              <span className="badge recheck">{t("sceneDraft.otherRevisionAdopted")}</span>
            )}
          </>
        )}
      </p>

      {draft.unresolved_sources.length > 0 && (
        <p className="warn-text small">
          {t("sceneDraft.unresolvedSources", { sources: draft.unresolved_sources
            .map((u) => u.source.label ?? u.source.id.slice(0, 8))
            .join(" / ") })}
        </p>
      )}

      <details className="subtle">
        <summary className="muted">{t("sceneDraft.approvedSourceText")}</summary>
        <pre>{draft.scene.content}</pre>
      </details>

      <h4>{t("sceneDraft.thisScene")}</h4>
      <p className="draft-scene">{draft.scene.content}</p>
      <p className="muted small">{t("sceneDraft.source", { sources: srcList(draft.scene.sources) })}</p>

      <h4>{t("sceneDraft.inheritedConstraints")}</h4>
      {draft.constraints.length === 0 ? (
        <p className="muted small">
          {draft.unresolved_sources.length > 0
            ? t("sceneDraft.noConstraintWithUnresolved")
            : t("sceneDraft.none")}
        </p>
      ) : (
        sectionList(draft.constraints)
      )}

      <h4>{t("sceneDraft.workContext")}</h4>
      <p className="muted small">
        {t("sceneDraft.workContextHint")}
      </p>
      {draft.context.length === 0 ? (
        <p className="muted small">{t("sceneDraft.none")}</p>
      ) : (
        sectionList(draft.context)
      )}

      {draft.unclassified.length > 0 && (
        <>
          <h4>{t("sceneDraft.otherApprovedText")}</h4>
          <p className="muted small">
            {t("sceneDraft.otherApprovedHint")}
          </p>
          {sectionList(draft.unclassified)}
        </>
      )}

      <h4>{t("sceneDraft.openQuestions")}</h4>
      <p className="muted small">
        {t("sceneDraft.openQuestionsHint")}
      </p>
      {draft.open_questions.length === 0 ? (
        <p className="muted small">{t("sceneDraft.none")}</p>
      ) : (
        <ul className="check-list">
          {draft.open_questions.map((q, i) => (
            <li key={i} className="check missing">
              <span className="check-icon" aria-hidden>
                ?
              </span>
              <span>
                <span className="badge recheck">
                  {t(CHECK_STATUS_LABEL[q.status])}
                </span>{" "}
                {q.note}
                {q.related.map((r, j) => (
                  <div key={j} className="draft-related">
                    {r.content}
                    <div className="muted small">
                      {t("sceneDraft.source", { sources: srcList(r.sources) })}
                    </div>
                  </div>
                ))}
                {q.uninspected.length > 0 && (
                  <div className="muted small">
                    {t("sceneDraft.uninspectedRefs", { sources: srcList(q.uninspected) })}
                  </div>
                )}
                {q.sources.length > 0 && (
                  <div className="muted small">{t("sceneDraft.related", { sources: srcList(q.sources) })}</div>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {draft.ref_assets.length > 0 && (
        <>
          <h4>{t("sceneDraft.referenceAssets")}</h4>
          <p className="muted small">
            {t("sceneDraft.referenceAssetsHint")}
          </p>
          <ul className="check-list">
            {draft.ref_assets.map((a) => (
              <li key={a.id} className="check">
                <span>
                  {a.label}
                  {!a.content_inspected && (
                    <span className="muted small">{t("sceneDraft.contentNotInspectedParen")}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {draft.uninspected_sources.length > 0 && (
        <>
          <h4>{t("sceneDraft.uninspectedRefsTitle")}</h4>
          <p className="muted small">
            {t("sceneDraft.uninspectedRefsHint")}
          </p>
          <ul className="check-list">
            {draft.uninspected_sources.map((s, i) => (
              <li key={i} className="check">
                <span>{s.label ?? s.id.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {!props.saved && props.onSave && (
        <button
          className="primary"
          disabled={props.saving}
          onClick={props.onSave}
        >
          {props.saving ? t("sceneDraft.saving") : t("sceneDraft.save")}
        </button>
      )}
      {props.saved && (
        <SceneDraftReviewPanel
          key={`${props.state.project.id}:${props.saved.id}`}
          projectId={props.state.project.id}
          saved={props.saved}
          drafts={props.state.scene_input_drafts}
        />
      )}
    </div>
  );
}
