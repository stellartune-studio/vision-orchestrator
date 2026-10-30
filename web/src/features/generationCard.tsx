import type { DocumentView, GenerationRecord } from "@vo/shared";
import { useState } from "react";
import { assetUrl } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import { cameraWorkStateOf } from "./cameraWork.ts";
import { cancelGeneration } from "./cancelGeneration.ts";
import { dimensionsDiffer, pixelDimensions, requestedDimensions, type Dimensions } from "./outputDimensions.ts";

const STATUS_BADGE: Record<GenerationRecord["status"], string> = {
  queued: "proposed",
  running: "proposed",
  succeeded: "adopted",
  failed: "recheck",
};

export const statusKey = (status: GenerationRecord["status"]) => `generation.status.${status}`;
export const kindKey = (kind: GenerationRecord["kind"]) => `generation.kind.${kind}`;
export const isCanceled = (rec: GenerationRecord) => rec.status === "failed" && /^remote status cancel(?:ed|led)$/i.test(rec.error ?? "");

export function GenerationCard(props: {
  rec: GenerationRecord;
  versionNo: number | null;
  documents: DocumentView[];
  /** why the recorded inputs can't simply be re-issued — fixToDocs
   *  marks blocks whose repair lives under Versions & documents */
  retryBlock: { reason: string; fixToDocs: boolean } | null;
  videoSupported: boolean;
  /** another generation is queued/running — re-issue is held to
   *  one-at-a-time, same contract as the main generate button */
  concurrentRunning: boolean;
  /** jump to Work content → Versions & documents, where a blocked
   *  retry's inputs (version/document adoption) can be fixed */
  onOpenDocs: () => void;
  /** re-issue this record's exact inputs as a NEW generation —
   *  the saved result stays untouched */
  onReissue: (rec: GenerationRecord) => void;
  /** consult the AI about the document revision this record used —
   *  honest "change the mood" entry that routes through approval */
  onAmendDoc: (docId: string, revisionId: string) => void;
  /** select this output as a material and freeze a NEW version that
   *  references it — first step toward animating it as a first frame */
  onUseAsFirstFrame: (rec: GenerationRecord) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const { rec } = props;
  const [cancelState, setCancelState] = useState<"idle" | "sending" | "requested">("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [measurement, setMeasurement] = useState<{ assetId: string; size: Dimensions } | null>(null);
  const requested = requestedDimensions(rec.inputs);
  const measured = measurement?.assetId === rec.output_asset_id ? measurement.size : null;
  const measure = (width: number, height: number) => {
    const size = pixelDimensions(width, height);
    setMeasurement(size && rec.output_asset_id ? { assetId: rec.output_asset_id, size } : null);
  };
  let inputs: {
    prompt?: string;
    settings?: Record<string, unknown>;
    resolved_refs?: Record<string, unknown>;
  } = {};
  try {
    inputs = JSON.parse(rec.inputs) as typeof inputs;
  } catch {
    /* keep {} */
  }
  const backend = (inputs.resolved_refs?.backend ?? {}) as Record<
    string,
    unknown
  >;
  const running = rec.status === "running" || rec.status === "queued";
  const canceled = isCanceled(rec);
  const cameraWorkState = cameraWorkStateOf(rec);
  const usedDoc = rec.document_revision_id
    ? props.documents.find((d) =>
        d.revisions.some((r) => r.id === rec.document_revision_id),
      )
    : undefined;
  const usedRev = usedDoc?.revisions.find(
    (r) => r.id === rec.document_revision_id,
  );
  return (
    <div className="item">
      <div className="item-head">
        <span className="item-label">
          {t(kindKey(rec.kind))}
          {props.versionNo != null && (
            <span className="muted">{t("generation.blueprintVersion", { version: props.versionNo })}</span>
          )}
        </span>
        <span className="badge quiet">{rec.backend}</span>
        <span className={`badge ${STATUS_BADGE[rec.status]}`}>
          {canceled ? (t("generationCard.canceled")) : t(statusKey(rec.status))}
        </span>
        <span className="muted small">{rec.created_at}</span>
      </div>
      {usedDoc && usedRev && (
        <p className="muted small">
          {t("generation.usedDocument", { title: usedDoc.title || t(`content.doc.${usedDoc.kind}`), kind: t(`content.doc.${usedDoc.kind}`), version: usedRev.rev_no })}
          {usedDoc.adopted_revision_id !== usedRev.id &&
            ` — ${t("generation.differentRevisionApproved")}`}
        </p>
      )}
      {running && (
        <>
          <div
            className="gen-progress"
            role="progressbar"
            aria-label={t("generation.progressAria")}
          >
            <i className="a" aria-hidden />
            <i className="b" aria-hidden />
          </div>
          <p className="muted small">
            {t("generation.waitingForBackend")}
          </p>
          <button disabled={cancelState !== "idle" || !rec.backend_job_id || rec.backend !== "comfy-sdk"} onClick={() => {
            setCancelState("sending"); setCancelError(null);
            void cancelGeneration(rec.id).then(() => setCancelState("requested")).catch((error: unknown) => {
              setCancelState("idle"); setCancelError(error instanceof Error ? error.message : String(error));
            });
          }}>{t("generationCard.requestCancellation")}</button>
          {cancelState === "requested" && <p role="status">{t("generationCard.cancellationRequestedWaitingForTheFinal")}</p>}
          {cancelError && <p role="alert">{cancelError}</p>}
        </>
      )}
      {cameraWorkState && (
        <p className="muted small">
          {t(`generation.cameraWork.${cameraWorkState}`)}
        </p>
      )}
      {running && rec.error && (
        <div className="gen-reconcile" role="status">
          <p>{t("generation.reconciling")}</p>
          <p className="item-content error-text">{rec.error}</p>
        </div>
      )}
      <div className="output-dimensions muted small">
        <div data-size="requested">{t("generation.size.requested")}: {requested ? `${requested.width} × ${requested.height} px` : t("generation.size.notRecorded")}</div>
        <div data-size="measured">{t("generation.size.measured")}: {measured ? `${measured.width} × ${measured.height} px` : t("generation.size.notMeasured")}</div>
        {dimensionsDiffer(requested, measured) && <p className="recheck" data-size="mismatch">{t("generation.size.different")}</p>}
        <p>{t("generation.size.note")}</p>
      </div>
      {rec.output_asset_id &&
        (rec.kind === "video" ? (
          <div className="gen-result">
            <video src={assetUrl(rec.output_asset_id)} controls
              onLoadedMetadata={(e) => measure(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
              onError={() => setMeasurement(null)} />
          </div>
        ) : (
          <div className="gen-result">
            <img src={assetUrl(rec.output_asset_id)} alt={t("generation.resultAlt")}
              onLoad={(e) => measure(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
              onError={() => setMeasurement(null)} />
          </div>
        ))}
      {rec.status === "succeeded" && rec.output_asset_id && (
        <p className="muted small">
          {t("generation.savedOutput")}
        </p>
      )}
      {rec.status === "succeeded" && (
        <div className="gen-actions">
          <div className="row wrap">
            {usedDoc && usedRev && (
              <button
                className="link"
                disabled={props.busy}
                onClick={() => props.onAmendDoc(usedDoc.id, usedRev.id)}
              >
                {t("generation.changeMood")}
              </button>
            )}
            <button
              disabled={props.busy || props.retryBlock !== null || props.concurrentRunning}
              onClick={() => props.onReissue(rec)}
            >
              {t("generation.reissue")}
            </button>
            {rec.kind === "image" && props.videoSupported && (
              <button
                disabled={props.busy}
                onClick={() => props.onUseAsFirstFrame(rec)}
              >
                {t("generation.useAsFirstFrame")}
              </button>
            )}
          </div>
          <p className="muted small">
            {props.retryBlock
              ? t("generation.retryBlockedKeepResult", { reason: props.retryBlock.reason })
              : props.concurrentRunning
                ? t("generation.disabled.running")
                : t("generation.reissueHistory")}
          </p>
        </div>
      )}
      {rec.status === "failed" && (
        <div className="gen-failure" role="alert">
          <p className="item-content error-text">
            {rec.error ?? t("generation.unknownFailure")}
          </p>
          {props.retryBlock ? (
            <>
              <p className="muted small">
                {props.retryBlock.reason}
                {props.retryBlock.fixToDocs && ` ${t("generation.verifyRetryInputs")}`}
              </p>
              {props.retryBlock.fixToDocs && (
                <button className="link" onClick={props.onOpenDocs}>
                  {t("generation.openWorkContent")} →
                </button>
              )}
            </>
          ) : (
            <>
              <button
                disabled={props.busy || props.concurrentRunning}
                onClick={() => props.onReissue(rec)}
              >
                {t("generation.retryNewRequest")}
              </button>
              <p className="muted small">
                {props.concurrentRunning
                  ? t("generation.disabled.running")
                  : t("generation.retryExplanation")}
              </p>
            </>
          )}
        </div>
      )}
      <details className="subtle">
        <summary className="muted">{t("generation.inputsTrace")}</summary>
        <pre>
          {`prompt:\n${inputs.prompt ?? ""}\n\nbackend:\n${JSON.stringify(backend, null, 2)}\n\nrefs:\n${JSON.stringify(inputs.resolved_refs ?? {}, null, 2)}`}
        </pre>
      </details>
    </div>
  );
}
