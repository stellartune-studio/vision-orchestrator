import { useState } from "react";
import type { DocumentView, GenerationRecord, ProjectState } from "@vo/shared";
import { assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { GenerationCard, isCanceled, kindKey, statusKey } from "./generationCard.tsx";
import { VideoEditPanel } from "./videoEditPanel.tsx";
import { ModeLane, type WorkMode } from "./modes.tsx";
import { Icon } from "./icon.tsx";
import type { NextGuidance } from "./summary.tsx";
import { requestedDimensions } from "./outputDimensions.ts";

const STATUS_TONE: Record<GenerationRecord["status"], string> = {
  queued: "proposed",
  running: "proposed",
  succeeded: "adopted",
  failed: "recheck",
};

/** One side of the A/B take comparison — media plus the facts a
 *  director needs to tell the two takes apart (version, document,
 *  recorded request size, status). Read-only: actions stay on the
 *  single preview so compare never forks a mutation path. */
function ComparePane(props: {
  tag: "A" | "B";
  rec: GenerationRecord | null;
  versionNoById: Map<string, number>;
  documents: DocumentView[];
}) {
  const { t } = useI18n();
  const { rec } = props;
  if (!rec) {
    return (
      <div className="compare-pane compare-empty">
        <span className="cmp-tag">{props.tag}</span>
        <p className="muted small">{t("stage.comparePick")}</p>
      </div>
    );
  }
  const versionNo = rec.blueprint_version_id
    ? (props.versionNoById.get(rec.blueprint_version_id) ?? null)
    : null;
  const usedDoc = rec.document_revision_id
    ? props.documents.find((d) =>
        d.revisions.some((r) => r.id === rec.document_revision_id),
      )
    : undefined;
  const usedRev = usedDoc?.revisions.find(
    (r) => r.id === rec.document_revision_id,
  );
  const requested = requestedDimensions(rec.inputs);
  return (
    <div className="compare-pane">
      <div className="item-head">
        <span className="cmp-tag">{props.tag}</span>
        <span className="item-label">
          {t(kindKey(rec.kind))}
          {versionNo != null && (
            <span className="muted">
              {t("generation.blueprintVersion", { version: versionNo })}
            </span>
          )}
        </span>
        <span className={`badge ${STATUS_TONE[rec.status]}`}>
          {isCanceled(rec) ? (t("genStage.canceled")) : t(statusKey(rec.status))}
        </span>
        <span className="muted small">{rec.created_at}</span>
      </div>
      {rec.output_asset_id ? (
        <div className="gen-result">
          {rec.kind === "video" ? (
            <video src={assetUrl(rec.output_asset_id)} controls muted playsInline />
          ) : (
            <img
              src={assetUrl(rec.output_asset_id)}
              alt={t("generation.resultAlt")}
            />
          )}
        </div>
      ) : (
        <div className="compare-noout">
          <p className="muted small">
            {t("stage.compareNone", { status: isCanceled(rec) ? (t("genStage.canceled2")) : t(statusKey(rec.status)) })}
          </p>
          {rec.status === "failed" && rec.error && (
            <p className="item-content error-text">{rec.error}</p>
          )}
        </div>
      )}
      {usedDoc && usedRev && (
        <p className="muted small">
          {t("generation.usedDocument", {
            title: usedDoc.title || t(`content.doc.${usedDoc.kind}`),
            kind: t(`content.doc.${usedDoc.kind}`),
            version: usedRev.rev_no,
          })}
        </p>
      )}
      <p className="muted small">
        {t("generation.size.requested")}:{" "}
        {requested
          ? `${requested.width} × ${requested.height} px`
          : t("generation.size.notRecorded")}
      </p>
    </div>
  );
}

function SampleShowcase(props: {
  guidance: NextGuidance;
  onSelect: (pane: "chat" | "content" | "generate" | "characters", tab?: "items" | "docs") => void;
}) {
  const { t } = useI18n();
  const [showSample, setShowSample] = useState(true);
  const step = props.guidance.kind === "step" ? props.guidance.step : null;
  return showSample ? (
    <section className="sample-showcase" aria-label={t("stage.sampleTitle")}>
      <div className="sample-art">
        <svg viewBox="0 0 820 300" role="img" aria-label={t("stage.sampleArtAlt")}>
          <defs>
            <linearGradient id="sample-sky" x2="0" y2="1"><stop stopColor="#192744"/><stop offset="1" stopColor="#526887"/></linearGradient>
            <linearGradient id="sample-window" x2="1" y2="1"><stop stopColor="#f7d49a" stopOpacity=".9"/><stop offset="1" stopColor="#89a9d4" stopOpacity=".2"/></linearGradient>
            <radialGradient id="sample-glow"><stop stopColor="#f6cf8c" stopOpacity=".8"/><stop offset="1" stopColor="#f6cf8c" stopOpacity="0"/></radialGradient>
          </defs>
          <rect width="820" height="300" fill="url(#sample-sky)"/><circle cx="590" cy="128" r="130" fill="url(#sample-glow)"/>
          <path d="M34 28h752v239H34z" fill="none" stroke="#c7d5eb" strokeOpacity=".27" strokeWidth="8"/><path d="M408 31v233M39 180h738" stroke="#c7d5eb" strokeOpacity=".24" strokeWidth="5"/>
          <path d="M54 240Q220 170 390 242T770 223v44H54z" fill="#26354f"/><path d="M78 45h290v128H78z" fill="url(#sample-window)" opacity=".45"/>
          <path d="M115 67v90m48-90v90m49-90v90m48-90v90m48-90v90" stroke="#cce5f3" strokeOpacity=".5" strokeWidth="2"/>
          <g transform="translate(315 85)"><ellipse cx="83" cy="165" rx="62" ry="11" fill="#131b2d" opacity=".6"/><path d="M48 65Q48 16 83 12q38 3 38 53l-7 37-62-1z" fill="#2a2336"/><ellipse cx="82" cy="59" rx="30" ry="38" fill="#f0c7a8"/><path d="M52 48Q51 13 82 10q35 0 38 34Q92 29 52 48" fill="#402d39"/><path d="M59 94q24 13 48 0l27 66H31z" fill="#d77e82"/><path d="M44 118l-29 34m86-33 31 30" stroke="#f0c7a8" strokeWidth="10" strokeLinecap="round"/><circle cx="72" cy="59" r="2" fill="#463544"/><circle cx="93" cy="59" r="2" fill="#463544"/><path d="M74 74q9 6 17 0" fill="none" stroke="#a45f67" strokeWidth="2" strokeLinecap="round"/></g>
          <g fill="#c5d7ec" opacity=".6">{Array.from({length:18},(_,i)=><path key={i} d={`M${22+i*47} ${15+(i*37)%240}v18`} stroke="#c5d7ec" strokeWidth="2"/>)}</g>
        </svg>
        <div className="sample-art-label"><span className="badge mock">SAMPLE · MOCK</span><span>{t("stage.sampleNotGenerated")}</span></div>
      </div>
      <div className="sample-details">
        <div><span className="sample-kicker">{t("stage.sampleWork")}</span><h3>{t("stage.sampleName")}</h3><p>{t("stage.sampleDescription")}</p></div>
        <div className="sample-links"><span><b>01</b>{t("stage.sampleCharacter")}</span><span><b>02</b>{t("stage.sampleBackground")}</span></div>
        <div className="sample-variants"><span>{t("stage.sampleCompare")}</span><i>A · {t("stage.sampleWarm")}</i><i>B · {t("stage.sampleCool")}</i></div>
      </div>
      <button className="sample-toggle" onClick={() => setShowSample(false)}>{t("stage.showEmpty")}</button>
    </section>
  ) : (
    <div className="stage-empty">
      <span className="stage-empty-mark" aria-hidden><Icon name="landscape" /></span><p className="stage-empty-title">{t("stage.noResults")}</p>
      {step ? (
        <>
          <p className="muted small">{step.detail ?? t("stage.firstWorkHint")}</p>
          {step.pane !== "generate" && (
            <button
              className="button primary"
              onClick={() => props.onSelect(step.pane, step.tab)}
            >
              {step.label} →
            </button>
          )}
        </>
      ) : (
        <p className="muted small">{t("stage.firstWorkHint")}</p>
      )}
      <button className="button ghost" onClick={() => setShowSample(true)}>{t("stage.showSample")}</button>
    </div>
  );
}

export function GenerationStageContent(props: {
  state: ProjectState;
  mode: WorkMode;
  generations: GenerationRecord[];
  selected: GenerationRecord | null;
  justFinishedId: string | null;
  selectedVersionNo: number | null;
  /** why the selected record can't be re-issued right now —
   *  fixToDocs marks blocks repaired under Work content → documents */
  retryBlock: { reason: string; fixToDocs: boolean } | null;
  /** another generation is queued/running — retries and re-issues are
   *  held to one-at-a-time, same as the main generate button */
  concurrentRunning: boolean;
  videoSupported: boolean;
  guidance: NextGuidance;
  /** A/B take comparison — on = strip clicks pick the pair, off =
   *  strip clicks switch the single preview */
  comparing: boolean;
  compareList: GenerationRecord[];
  versionNoById: Map<string, number>;
  onToggleCompare: () => void;
  onSelect: (pane: "chat" | "content" | "generate" | "characters", tab?: "items" | "docs") => void;
  onSelectGeneration: (id: string) => void;
  onReissue: (rec: GenerationRecord) => void;
  onAmendDoc: (docId: string, revisionId: string) => void;
  onUseAsFirstFrame: (rec: GenerationRecord) => void;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const comparePair = [props.compareList[0] ?? null, props.compareList[1] ?? null];
  return (
    <>
      <div
        className={`stage-preview${
          props.selected && props.justFinishedId === props.selected.id ? " is-done" : ""
        }`}
      >
        {props.comparing ? (
          <div className="compare-grid" role="group" aria-label={t("stage.compare")}>
            <ComparePane
              tag="A"
              rec={comparePair[0]}
              versionNoById={props.versionNoById}
              documents={props.state.documents}
            />
            <ComparePane
              tag="B"
              rec={comparePair[1]}
              versionNoById={props.versionNoById}
              documents={props.state.documents}
            />
          </div>
        ) : props.selected ? (
          <>
          <GenerationCard
            // remount on switch — the media gets a short fade/zoom-in
            // so result changes read as a change, not a jump
            key={props.selected.id}
            rec={props.selected}
            versionNo={props.selectedVersionNo}
            documents={props.state.documents}
            retryBlock={props.retryBlock}
            concurrentRunning={props.concurrentRunning}
            videoSupported={props.videoSupported}
            onOpenDocs={() => props.onSelect("content", "docs")}
            onReissue={props.onReissue}
            onAmendDoc={props.onAmendDoc}
            onUseAsFirstFrame={props.onUseAsFirstFrame}
            busy={props.busy}
          />
          {props.selected.kind === "video" && props.selected.status === "succeeded" && props.selected.output_asset_id && (
            <VideoEditPanel
              projectId={props.state.project.id}
              sourceAssetId={props.selected.output_asset_id}
              onChanged={props.onChanged}
            />
          )}
          </>
        ) : (
          <SampleShowcase guidance={props.guidance} onSelect={props.onSelect} />
        )}
      </div>

      {/* the mode's working lane swaps under the preview — the preview
          itself stays mounted so the work is visibly continuous */}
      <ModeLane key={props.mode} mode={props.mode} state={props.state} />

      {props.generations.length > 0 && (
        <>
          <div className="strip-head">
            <span className="muted small">
              {props.comparing
                ? props.compareList.length === 1
                  ? t("stage.compareNeedMore")
                  : t("stage.compareHint")
                : t("stage.resultSwitch")}
            </span>
            {props.generations.length >= 2 && (
              <button
                className={props.comparing ? "ghost strip-compare on" : "ghost strip-compare"}
                aria-pressed={props.comparing}
                onClick={props.onToggleCompare}
              >
                {props.comparing ? t("stage.compareExit") : t("stage.compare")}
              </button>
            )}
          </div>
          <div
            className="stage-strip"
            role="group"
            aria-label={t("stage.resultSwitch")}
          >
            {props.generations.map((g) => {
              const hasOut = g.status === "succeeded" && g.output_asset_id;
              const pickedIndex = props.comparing
                ? props.compareList.findIndex((r) => r.id === g.id)
                : -1;
              const marked = props.comparing
                ? pickedIndex >= 0
                : props.selected?.id === g.id;
              return (
                <button
                  key={g.id}
                  aria-pressed={marked}
                  className={`strip-item st-${g.status}${marked ? " sel" : ""}`}
                  onClick={() => props.onSelectGeneration(g.id)}
                  title={t("generation.filmstripTitle", { kind: t(kindKey(g.kind)), status: isCanceled(g) ? (t("genStage.canceled3")) : t(statusKey(g.status)), date: g.created_at })}
                >
                  {hasOut && g.kind === "image" ? (
                    <img src={assetUrl(g.output_asset_id!)} alt="" />
                  ) : hasOut ? (
                    <video
                      src={assetUrl(g.output_asset_id!)}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <span className="strip-ph" aria-hidden>
                      {g.status === "failed" ? "✕" : "…"}
                    </span>
                  )}
                  {pickedIndex >= 0 && (
                    <span className="strip-tag" aria-hidden>
                      {pickedIndex === 0 ? "A" : "B"}
                    </span>
                  )}
                  <span className={`strip-dot st-${g.status}`} aria-hidden />
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
