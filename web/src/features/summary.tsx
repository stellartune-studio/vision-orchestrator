import type { ProjectState, ServerMeta } from "@vo/shared";
import { assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { adoptionBadgeClass } from "./labels.ts";
import {
  buildReadiness,
  detailForReadiness,
  useBlueprintDetail,
  type DetailStatus,
} from "./readiness.ts";

type PaneId = "chat" | "content" | "generate" | "characters";

interface NextStep {
  label: string;
  detail?: string;
  pane: PaneId;
  tab?: "items" | "docs";
}

/**
 * Guidance for what to do next — derived from the counts and flags the
 * server already returns (adoption axis, pending axis, versions,
 * document approval). Advisory only; the server remains authoritative.
 */
export function nextStep(
  state: ProjectState,
  pendingTotal: number,
  readiness: ReturnType<typeof buildReadiness>,
  translate?: (key: string, values?: Record<string, string | number>) => string,
): NextStep {
  const adopted = state.items.filter((i) => i.adoption === "adopted");
  const lastGen = state.generations[0];

  if (pendingTotal > 0) {
    return {
      label: translate?.("summary.next.pending") ?? "Review pending proposals",
      detail: translate?.("summary.next.pendingDetail", { count: pendingTotal }) ?? `${pendingTotal} proposals are waiting for adoption or dismissal`,
      pane: "content",
      tab: "items",
    };
  }
  if (adopted.length === 0) {
    return {
      label: translate?.("summary.next.consult") ?? "Consult to gather proposals",
      detail: translate?.("summary.next.consultDetail") ?? "Describe what you want to make; the director AI proposes blueprint items",
      pane: "chat",
    };
  }
  const missing = readiness.find((r) => r.tone === "missing");
  if (missing) {
    return {
      label: missing.label,
      detail: missing.detail,
      pane: "content",
      tab: /必須項目|Required items/i.test(missing.label) ? "items" : "docs",
    };
  }
  if (lastGen?.status === "running" || lastGen?.status === "queued") {
    return {
      label: translate?.("summary.next.results") ?? "View generation results",
      detail: translate?.("summary.next.resultsDetail") ?? "A generation is in progress",
      pane: "generate",
    };
  }
  return {
    label: translate?.("summary.next.generate") ?? "Generate",
    detail: translate?.("summary.next.generateDetail") ?? "Prerequisites look ready (final check is on the server)",
    pane: "generate",
  };
}

/**
 * What the guidance surfaces may say, depending on the shared
 * blueprint-detail fetch. "loading"/"error" never guess a next action —
 * a failed read is not proof the prerequisites are met.
 */
export type NextGuidance =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "step"; step: NextStep };

export function nextGuidance(
  hasVersion: boolean,
  detailStatus: DetailStatus,
  step: NextStep,
): NextGuidance {
  if (hasVersion && detailStatus === "loading") return { kind: "loading" };
  if (hasVersion && detailStatus === "error") return { kind: "error" };
  return { kind: "step", step };
}

/**
 * One-line "what next" strip for narrow layouts, where the rail and
 * side panel are hidden. Derives its answer from the same nextStep()
 * advisory logic — it just navigates, never mutates state.
 */
export function NextStepStrip(props: {
  state: ProjectState;
  meta: ServerMeta | null;
  onSelect: (pane: PaneId, tab?: "items" | "docs") => void;
}) {
  const { t } = useI18n();
  const { state, meta } = props;
  const latest = state.blueprint_versions.at(-1);
  const {
    status: detailStatus,
    detail,
    retry,
  } = useBlueprintDetail(latest?.id);

  const pendingTotal =
    state.items.reduce((n, i) => n + i.pending_proposals.length, 0) +
    state.documents.reduce((n, d) => n + d.pending_proposals.length, 0);
  const readiness = buildReadiness(
    state,
    meta,
    detailForReadiness(!!latest, detailStatus, detail),
    t,
  );
  const g = nextGuidance(!!latest, detailStatus, nextStep(state, pendingTotal, readiness, t));

  return (
    <div className="next-strip">
      <span className="next-strip-hint">{t("summary.next.title")}</span>
      {g.kind === "loading" && (
        <span className="next-strip-label muted">{t("summary.next.checking")}</span>
      )}
      {g.kind === "error" && (
        <>
          <span className="next-strip-label">{t("summary.next.checkFailed")}</span>
          <button onClick={retry}>{t("summary.next.retry")}</button>
        </>
      )}
      {g.kind === "step" && (
        <>
          <span className="next-strip-label">{g.step.label}</span>
          <button
            className="primary"
            onClick={() => props.onSelect(g.step.pane, g.step.tab)}
          >
            {t("summary.next.goOn")} →
          </button>
        </>
      )}
    </div>
  );
}

export function StatusPanel(props: {
  state: ProjectState;
  meta: ServerMeta | null;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
  onSelect: (pane: PaneId, tab?: "items" | "docs") => void;
}) {
  const { t } = useI18n();
  const { state } = props;
  const latest = state.blueprint_versions.at(-1);

  const adopted = state.items.filter((i) => i.adoption === "adopted");
  const pendingTotal =
    state.items.reduce((n, i) => n + i.pending_proposals.length, 0) +
    state.documents.reduce((n, d) => n + d.pending_proposals.length, 0);
  const recheckDocs = state.documents.filter(
    (d) => d.consistency === "needs_recheck",
  );

  // The reference imagery feeding the NEXT version — saved outputs
  // live on the stage's preview + filmstrip now, so this tab only
  // carries what a version would consume.
  const refAssets = state.assets.filter(
    (a) =>
      a.selected === 1 &&
      a.owner_kind === "project" &&
      a.owner_id === state.project.id &&
      a.mime?.startsWith("image/"),
  );
  const charBaseImages = state.characters
    .map((pc) => {
      const view = state.character_views.find(
        (v) => v.id === pc.character_id,
      );
      const rev = view?.revisions.find(
        (r) => r.id === pc.character_revision_id,
      );
      return view && rev?.base_image_asset_id
        ? { name: view.name, assetId: rev.base_image_asset_id }
        : null;
    })
    .filter((x): x is { name: string; assetId: string } => x !== null);

  return (
    <div className="summary">
      {(refAssets.length > 0 || charBaseImages.length > 0) && (
        <section className="card">
          <h3>{t("summary.referenceImages")}</h3>
          <div className="thumb-grid">
            {charBaseImages.map((c) => (
              <button
                key={c.assetId}
                className="thumb"
                title={t("summary.characterReferenceImage", { name: c.name })}
                onClick={() => props.onSelect("characters")}
              >
                <img
                  src={assetUrl(c.assetId)}
                  alt={t("summary.characterReferenceImage", { name: c.name })}
                />
                <span className="thumb-tag">{c.name}</span>
              </button>
            ))}
            {refAssets.map((a) => (
              <span
                key={a.id}
                className="thumb"
                title={t("summary.selectedForNextVersion")}
              >
                <img src={assetUrl(a.id)} alt={t("summary.selectedReferenceMaterial")} />
                <span className="thumb-tag">{t("summary.selected")}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h3>{t("summary.currentState")}</h3>
        <ul className="stat-list">
          <li>
            {t("summary.adoptedItems", { count: adopted.length })}
          </li>
          <li>
            {t("summary.pendingProposals", { count: pendingTotal })}
            {pendingTotal > 0 && (
              <button
                className="link"
                onClick={() => props.onSelect("content", "items")}
              >
                {t("summary.review")} →
              </button>
            )}
          </li>
          <li>
            {t("summary.finalizedVersion")} {" "}
            <strong>{latest ? `v${latest.version_no}` : t("summary.none")}</strong>
          </li>
          {recheckDocs.length > 0 && (
            <li className="warn-text">
              {t("summary.documentsNeedReview", { count: recheckDocs.length })}
              <button
                className="link"
                onClick={() => props.onSelect("content", "docs")}
              >
                {t("summary.review")} →
              </button>
            </li>
          )}
        </ul>
      </section>

      <details className="card">
        <summary>
          {t("summary.adoptedDetails", { count: adopted.length })}
        </summary>
        {adopted.length === 0 && (
          <p className="muted">
            {t("summary.noAdoptedItems")}
          </p>
        )}
        <ul className="adopted-list">
          {adopted.map((i) => (
            <li key={i.id}>
              <span className="muted">{t(`content.kind.${i.kind}`)}</span>{" "}
              <strong>{i.label}</strong>
              <div className="clamp">{i.adopted_revision?.content ?? ""}</div>
            </li>
          ))}
        </ul>
      </details>

      <details className="card" open={recheckDocs.length > 0}>
        <summary>
          {t("summary.documents", { count: state.documents.length })}
          {recheckDocs.length > 0 && ` — ${t("summary.reviewRequired")}`}
        </summary>
        {state.documents.length === 0 && (
          <p className="muted">
            {latest
              ? t("summary.noDocuments")
              : t("summary.noDocumentsNoVersion")}
          </p>
        )}
        <ul className="adopted-list">
          {state.documents.map((d) => (
            <li key={d.id}>
              <strong>{d.title || t(`content.doc.${d.kind}`)}</strong>{" "}
              <span className={`badge ${adoptionBadgeClass(d.adoption)}`}>
                {d.adoption === "adopted"
                  ? t("content.approved")
                  : t(`content.adoption.${d.adoption}`)}
              </span>{" "}
              {d.consistency === "needs_recheck" && (
                <span className="badge recheck">{t("summary.reviewRequired")}</span>
              )}
            </li>
          ))}
        </ul>
        {state.documents.length > 0 && (
          <button
            className="link"
            onClick={() => props.onSelect("content", "docs")}
          >
            {t("summary.openVersionsAndDocuments")} →
          </button>
        )}
      </details>
    </div>
  );
}
