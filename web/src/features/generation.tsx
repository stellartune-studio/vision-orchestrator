import { useEffect, useRef, useState } from "react";
import type {
  Asset,
  GenerationRecord,
  GenerationStatus,
  ProjectState,
  QwenReferenceSize,
  SceneInputDraft,
  SceneInputDraftRecord,
  ServerMeta,
  SavedWorkflowSelection,
} from "@vo/shared";
import { api, assetUrl, describeError } from "../api/client.ts";
import {
  chosenRevisionId,
  docCandidateLabel,
  docCandidatesFor,
  resolveDocChoice,
  retryBlockReason,
} from "./docSelection.ts";
import {
  blueprintDrifted,
  buildReadiness,
  detailForReadiness,
  readinessReady,
  useBlueprintDetail,
} from "./readiness.ts";
import { nextGuidance, nextStep } from "./summary.tsx";
import { modeDef, modeLabelKey, type WorkMode } from "./modes.tsx";
import { useI18n } from "../i18n.tsx";
import { SceneDraftCard } from "./sceneDraftCard.tsx";
import { kindKey } from "./generationCard.tsx";
import { GenerationStageContent } from "./generationStageContent.tsx";
import { Icon } from "./icon.tsx";
import { ModelEnvironmentPanel } from "./modelEnvironment.tsx";
import { hasFrozenImageReference } from "./qwenReferenceSize.ts";
import { useComparison } from "./useComparison.ts";
import "./modelEnvironment.css";

export { SceneDraftCard };

type PaneId = "chat" | "content" | "generate" | "characters";

export function GenerationPanel(props: {
  state: ProjectState;
  meta: ServerMeta | null;
  mode: WorkMode;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
  onSelect: (pane: PaneId, tab?: "items" | "docs") => void;
  /** open the chat pane with this document revision as the amend
   *  target — routes "change the mood" through the approval flow */
  onAmendDoc: (docId: string, revisionId: string) => void;
  /** one-line confirmation for a completed side action (e.g. a new
   *  blueprint version frozen for a first-frame image) */
  onFlash: (msg: string) => void;
  onReview?: () => void;
}) {
  const { t } = useI18n();
  const { state, meta } = props;
  const [workflowState, setWorkflowState] = useState<{ projectId: string; saved: SavedWorkflowSelection | null } | null>(null);
  const selection = workflowState?.projectId === state.project.id ? workflowState.saved : null;
  // inFlight is the synchronous submit guard — busy state only reflects
  // after a re-render, so same-task double dispatch can slip past it.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [duration, setDuration] = useState(1.5);
  const qwenEdit = !selection?.selection && meta?.gen_profile === "qwen-image-2.1-turbo-edit-single";
  const qwenImage = !selection?.selection && meta?.gen_profile === "qwen-image-2.1-turbo";
  const [editSource, setEditSource] = useState<{
    projectId: string;
    assetId: string;
  } | null>(null);
  const [editSeed, setEditSeed] = useState(891836227295375);
  const editSourceId =
    editSource?.projectId === state.project.id ? editSource.assetId : "";
  const editSourceAsset = state.assets.find((a) => a.id === editSourceId);
  const editSourceChoices = state.assets.filter(
    (a) =>
      a.owner_kind === "project" &&
      a.owner_id === state.project.id &&
      a.mime?.startsWith("image/"),
  );
  // The pick is a document REVISION id, not a document id — if a state
  // refresh moves adoption to a newer revision of the same document,
  // the stale pick must surface as "re-confirm", never hop across.
  //
  // Four states, never conflated into one null:
  //   uninitialized — pick key doesn't match this project/version
  //                   (a switch is an init, not a stale event);
  //   unpicked      — matching key, nothing chosen yet;
  //   picked        — auto (single candidate) or manual choice recorded;
  //   stale         — resolveDocChoice marks a picked revision that
  //                   left the candidate set.
  const latest = state.blueprint_versions.at(-1);
  const pickKey = `${state.project.id}:${latest?.id ?? ""}`;
  const [pick, setPick] = useState<{ key: string; revId: string } | null>(null);
  const pickedRevId = pick?.key === pickKey ? pick.revId : null;
  const {
    status: detailStatus,
    detail,
    retry: retryDetail,
  } = useBlueprintDetail(latest?.id);
  const [referenceSize, setReferenceSize] = useState<{ key: string; value: QwenReferenceSize; confirmed: boolean } | null>(null);
  const [referenceSizeLoading, setReferenceSizeLoading] = useState(false);
  const referenceKey = `${state.project.id}:${latest?.id ?? ""}`;
  const activeReferenceSize = referenceSize?.key === referenceKey ? referenceSize : null;
  const hasFrozenReference = hasFrozenImageReference(detail, state.assets);
  const needsReferenceSize = qwenImage && kind === "image" && !!latest && detail?.id === latest.id && hasFrozenReference;
  const genKinds = meta?.gen_kinds ?? ["image"];
  const videoSupported = genKinds.includes("video");
  const versionNoById = new Map(
    state.blueprint_versions.map((v) => [v.id, v.version_no]),
  );

  // Approved documents derived from the target version — the one that
  // feeds the prompt is chosen here, never silently by the server.
  const docCandidates = docCandidatesFor(state, latest?.id);
  const docChoice = resolveDocChoice(
    docCandidates,
    pickedRevId,
    state.documents,
  );
  const docRevToUse = chosenRevisionId(docChoice);

  // Scene input draft — a preview-only reorganization of the approved
  // revision. Two guards pin it to its target:
  //   1. the response is stored under the request's target key, so a
  //      late response is only shown while that target is current;
  //   2. the BODY's project/blueprint/revision ids must equal the
  //      requested ones — a mismatched body is never displayed, even
  //      under a matching request key.
  const draftTargetKey =
    latest && docRevToUse
      ? `${state.project.id}:${latest.id}:${docRevToUse}`
      : null;
  const [draft, setDraft] = useState<{
    key: string;
    data: SceneInputDraft;
  } | null>(null);
  const [draftErr, setDraftErr] = useState<{
    key: string;
    msg: string;
  } | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const draftInFlight = useRef(false);
  const draftTargetRef = useRef<string | null>(draftTargetKey);
  draftTargetRef.current = draftTargetKey;
  const [savedDraft, setSavedDraft] = useState<{
    key: string;
    data: SceneInputDraftRecord;
  } | null>(null);
  const shownDraft = draft && draft.key === draftTargetKey ? draft.data : null;
  const shownSavedDraft =
    savedDraft && savedDraft.key === draftTargetKey ? savedDraft.data : null;
  const shownDraftErr =
    draftErr && draftErr.key === draftTargetKey ? draftErr.msg : null;

  const loadSceneDraft = async () => {
    if (!latest || !docRevToUse || draftInFlight.current) return;
    const key = draftTargetKey;
    if (!key) return;
    draftInFlight.current = true;
    setDraftBusy(true);
    setSavedDraft(null);
    try {
      const data = await api.sceneDraft(
        state.project.id,
        latest.id,
        docRevToUse,
      );
      if (
        data.digest == null ||
        data.project_id !== state.project.id ||
        data.blueprint_version_id !== latest.id ||
        data.document_revision_id !== docRevToUse
      ) {
        if (draftTargetRef.current !== key) return;
        setDraftErr({
          key,
            msg: t("generation.draftTargetMismatch"),
        });
        setDraft(null);
        return;
      }
      if (draftTargetRef.current !== key) return;
      setDraft({ key, data });
      setDraftErr(null);
    } catch (e) {
      if (draftTargetRef.current === key) {
        setDraftErr({ key, msg: describeError(e) });
        setDraft(null);
        setSavedDraft(null);
      }
    } finally {
      draftInFlight.current = false;
      setDraftBusy(false);
    }
  };

  const saveSceneDraft = async () => {
    const key = draftTargetKey;
    if (!key || !latest || !docRevToUse || !shownDraft || draftInFlight.current)
      return;
    draftInFlight.current = true;
    setDraftBusy(true);
    try {
      const saved = await api.saveSceneInputDraft(state.project.id, {
        blueprint_version_id: latest.id,
        document_id: shownDraft.document_id,
        document_revision_id: docRevToUse,
        digest: shownDraft.digest,
      });
      if (draftTargetRef.current !== key) return;
      if (
        saved.project_id !== state.project.id ||
        saved.blueprint_version_id !== latest.id ||
        saved.document_id !== shownDraft.document_id ||
        saved.document_revision_id !== docRevToUse ||
        saved.digest !== shownDraft.digest ||
        saved.snapshot.digest !== shownDraft.digest
      ) {
        setDraftErr({
          key,
          msg: t("generation.draftSaveMismatch"),
        });
        setSavedDraft(null);
        return;
      }
      setSavedDraft({ key, data: saved });
      setDraftErr(null);
      await props.onChanged();
    } catch (e) {
      if (draftTargetRef.current === key) {
        setDraftErr({ key, msg: describeError(e) });
        setSavedDraft(null);
      }
    } finally {
      draftInFlight.current = false;
      setDraftBusy(false);
    }
  };

  // Record an implicit single-candidate choice as a real pick. Without
  // this, "auto" would silently follow when adoption moves to a newer
  // revision — with it, the move resolves as stale and asks the
  // director to re-confirm.
  const autoRevId =
    docChoice.kind === "auto" ? docChoice.candidate.rev.id : null;
  useEffect(() => {
    if (!autoRevId) return;
    setPick((p) =>
      p?.key === pickKey && p.revId === autoRevId
        ? p
        : { key: pickKey, revId: autoRevId },
    );
  }, [autoRevId, pickKey]);

  // A new generation may only leave when every client-visible
  // condition is verified: version exists, its detail fetched AND
  // matches the target id, a valid document revision is picked, and
  // nothing is in flight. Retries are validated separately — they may
  // legitimately target an older version.
  const detailMatches =
    !!latest && detailStatus === "ready" && detail?.id === latest.id;

  // Poll while any generation is in flight — each GET triggers the
  // server-side backend poll (a bare state refresh never touches it).
  const runningIds = state.generations
    .filter((g) => g.status === "running" || g.status === "queued")
    .map((g) => g.id);
  useEffect(() => {
    if (runningIds.length === 0) return;
    const t = setInterval(() => {
      Promise.all(runningIds.map((id) => api.getGeneration(id)))
        .then(() => props.onChanged())
        .catch(props.onError);
    }, 3000);
    return () => clearInterval(t);
  }, [runningIds.join(",")]);

  const submitGeneration = async (
    blueprintVersionId: string,
    kind: "image" | "video",
    documentRevisionId?: string,
    sourceAssetId?: string,
    seed?: number,
    durationOverride?: number,
    referenceSizeOverride?: QwenReferenceSize,
  ) => {
    if (inFlight.current || !selection) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api.generate(state.project.id, blueprintVersionId, {
        kind,
        duration_seconds:
          kind === "video" && !selection.selection ? (durationOverride ?? duration) : undefined,
        document_revision_id: documentRevisionId,
        edit_source_asset_id: sourceAssetId,
        reference_size: referenceSizeOverride,
        seed,
        selection_version: selection.version,
      });
      await props.onChanged();
    } catch (e) {
      props.onError(e);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // The fields a retry re-uses from the record — parsing lives in one
  // place so the "can this be re-issued?" check and the submit read
  // the same values.
  const recordedInputs = (rec: GenerationRecord) => {
    try {
      const r = JSON.parse(rec.inputs) as {
        settings?: { seed?: number; duration_seconds?: number; qwen_reference_size?: QwenReferenceSize };
        resolved_refs?: { edit_source_asset_id?: string };
      };
      return {
        duration: r.settings?.duration_seconds,
        source: r.resolved_refs?.edit_source_asset_id,
        seed: r.settings?.seed,
      };
    } catch {
      return {};
    }
  };

  // Why this record can't be re-issued right now — the reason doubles
  // as the card's disabled/hint text, so every silent-return path in
  // `reissue` below must be represented here (except the workflow-
  // selection mismatch, which is surfaced as an error on click).
  // fixToDocs marks blocks whose repair lives in Work content →
  // Versions & documents; other reasons keep the pointer in the text.
  const reissueBlock = (rec: GenerationRecord) => {
    const recorded = retryBlockReason(rec, state.documents, t);
    if (recorded) return { reason: recorded, fixToDocs: true };
    if (!selection)
      return { reason: t("generation.retryNoWorkflow"), fixToDocs: false };
    if (qwenEdit) {
      const { source, seed } = recordedInputs(rec);
      if (!source || seed == null)
        return { reason: t("generation.retryMissingRecorded"), fixToDocs: false };
    }
    return null;
  };

  // Re-issue a record's exact inputs (blueprint version, document
  // revision, duration — and for the edit profile its source+seed) as
  // a NEW generation. Used for both failed retries and "another take"
  // on succeeded results; blocked records keep their reason shown.
  // One generation at a time, same as the main button — a second
  // concurrent job is never launched from a retry.
  const reissue = (rec: GenerationRecord) => {
    if (retryBlockReason(rec, state.documents, t)) return;
    if (inFlight.current || runningIds.length > 0) return;
    if (!selection) return;
    try {
      if (JSON.stringify(JSON.parse(rec.inputs).settings?.workflow_selection ?? null) !== JSON.stringify(selection.selection)) {
        props.onError(new Error("Workflow selection changed. Restore the recorded selection before retrying. / workflow 設定が変わりました。記録時の設定を戻してから再試行してください。"));
        return;
      }
    } catch (e) { props.onError(e); return; }
    setKind(rec.kind);
    const recorded = recordedInputs(rec);
    const retryDuration = recorded.duration;
    const retrySource = qwenEdit ? recorded.source : undefined;
    const retrySeed = qwenEdit ? recorded.seed : undefined;
    if (qwenEdit && (!retrySource || retrySeed == null)) return;
    let recordedSize: QwenReferenceSize | undefined;
    try { recordedSize = (JSON.parse(rec.inputs) as { settings?: { qwen_reference_size?: QwenReferenceSize } }).settings?.qwen_reference_size; } catch { /* retry is rejected by server if confirmation is absent */ }
    void submitGeneration(
      rec.blueprint_version_id as string,
      rec.kind,
      rec.document_revision_id as string,
      retrySource,
      retrySeed,
      retryDuration,
      recordedSize,
    );
  };

  // "Animate this": the saved output becomes a selected material and a
  // NEW blueprint version freezes the reference. Generation itself is
  // never triggered — the user still creates and approves a document
  // derived from the new version, then runs video generation.
  const [assetConflict, setAssetConflict] = useState<{ rec: GenerationRecord; latest?: Asset } | null>(null);
  const useAsFirstFrame = async (rec: GenerationRecord, expectedVersion?: number) => {
    if (!rec.output_asset_id || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const asset = state.assets.find((a) => a.id === rec.output_asset_id);
      if (!asset) throw new Error("Reload project materials before selecting this output");
      await api.selectAsset(rec.output_asset_id, true, expectedVersion ?? asset.selection_version);
      setAssetConflict(null);
      const v = await api.createBlueprintVersion(
        state.project.id,
        t("generation.addFirstFrameInstruction"),
      );
      props.onFlash(
        t("generation.firstFrameVersionCreated", { version: v.version_no }),
      );
      await props.onChanged();
      props.onSelect("content", "docs");
    } catch (e) {
      if ((e as { status?: number }).status === 409) setAssetConflict({ rec });
      else props.onError(e);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const generate = async () => {
    // Same conditions as the disabled button — enforced again at the
    // entry point so a stale render can never slip a request through.
    const running = state.generations.some(
      (g) => g.status === "running" || g.status === "queued",
    );
    if (!latest || busy || running) return;
    if (!detailMatches || !docRevToUse) return;
    if (needsReferenceSize && !activeReferenceSize?.confirmed) return;
    if (
      qwenEdit &&
      (!editSourceAsset || !Number.isSafeInteger(editSeed) || editSeed < 0)
    ) {
      return;
    }
    await submitGeneration(
      latest.id,
      kind,
      docRevToUse,
      qwenEdit ? editSourceId : undefined,
      qwenEdit ? editSeed : undefined,
      undefined,
      needsReferenceSize ? activeReferenceSize?.value : undefined,
    );
  };

  const readiness = buildReadiness(
    state,
    meta,
    detailForReadiness(!!latest, detailStatus, detail),
    t,
  );
  const missing = readiness.filter((r) => r.tone === "missing");
  const ready = readinessReady(readiness);

  // What this generation would use — read from the frozen blueprint
  // VERSION, not the live edit state, so the preview matches the
  // input. A detail that isn't confirmed to be the target version's
  // (loading/error/mismatch) is never shown as "this version".
  const shownDetail = detailMatches ? detail : null;
  const snapChars = (shownDetail?.characters ?? []).map((c) => {
    const view = state.character_views.find((cv) => cv.id === c.character_id);
    const revNo = view?.revisions.find(
      (r) => r.id === c.character_revision_id,
    )?.rev_no;
    return {
      name: view?.name ?? c.character_id.slice(0, 8),
      revNo,
      hasBaseImage: c.base_image_asset_id != null,
    };
  });
  const snapAssetCount = shownDetail?.assets.length ?? 0;
  const drifted = shownDetail ? blueprintDrifted(shownDetail, state) : false;
  const anyRunning = runningIds.length > 0;

  // ---- stage selection -------------------------------------------------
  // The preview shows ONE record large; the filmstrip below switches
  // between takes without losing earlier results. Selection follows
  // real state only: a freshly submitted record takes focus, and a job
  // that reports "succeeded" while open is focused and gets a single
  // restrained completion pulse — no simulated progress.
  const gens = state.generations;
  const [selId, setSelId] = useState<string | null>(null);
  const [justFinished, setJustFinished] = useState<string | null>(null);
  const prevGenStatus = useRef<Map<string, GenerationStatus>>(new Map());
  useEffect(() => {
    const prev = prevGenStatus.current;
    const fresh = gens.filter((g) => !prev.has(g.id));
    const finished = gens.filter(
      (g) =>
        g.status === "succeeded" &&
        (prev.get(g.id) === "running" || prev.get(g.id) === "queued"),
    );
    prevGenStatus.current = new Map(gens.map((g) => [g.id, g.status]));
    if (fresh.length > 0) setSelId(fresh[0].id);
    if (finished.length > 0) {
      setSelId(finished[0].id);
      setJustFinished(finished[0].id);
      const t = setTimeout(() => setJustFinished(null), 1500);
      return () => clearTimeout(t);
    }
  }, [gens]);
  const sel = gens.find((g) => g.id === selId) ?? gens[0] ?? null;

  // Take comparison: null = single preview; an array of up to two
  // record ids pins the A/B pair. Clicks while comparing assign the
  // pair instead of switching the preview; the records are real
  // state, so a finishing take updates its compare pane live.
  const { ids: compareIds, change: setCompareIds, message: comparisonMessage, reload: reloadComparison } = useComparison(state.project.id);
  const comparing = compareIds !== null;
  const compareList = (compareIds ?? [])
    .map((id) => gens.find((g) => g.id === id))
    .filter((g): g is GenerationRecord => g != null);
  const pickCompare = (id: string) =>
    setCompareIds((ids) => {
      if (ids === null) return ids;
      if (ids.includes(id)) return ids.filter((x) => x !== id);
      return ids.length < 2 ? [...ids, id] : [ids[0], id];
    });

  const adoptedCount = state.items.filter(
    (i) => i.adoption === "adopted",
  ).length;
  const pendingTotal =
    state.items.reduce((n, i) => n + i.pending_proposals.length, 0) +
    state.documents.reduce((n, d) => n + d.pending_proposals.length, 0);
  const guidance = nextGuidance(
    !!latest,
    detailStatus,
    nextStep(state, pendingTotal, readiness, t),
  );

  const disabledReason = !latest
    ? t("generation.disabled.noVersion")
    : anyRunning
      ? t("generation.disabled.running")
      : busy
        ? t("generation.disabled.submitting")
        : detailStatus === "loading"
          ? t("generation.disabled.loadingBlueprint")
          : detailStatus === "error"
            ? t("generation.disabled.blueprintError")
            : !detailMatches
              ? t("generation.disabled.blueprintMismatch")
              : docChoice.kind === "stale"
                ? t("generation.disabled.documentStale")
                : docChoice.kind === "unselected"
                  ? t("generation.disabled.chooseDocument")
                  : docChoice.kind === "none"
                    ? t("generation.disabled.noApprovedDocument")
                    : null;

  return (
    <div className="stage-pane">
      {assetConflict && <div role="alert">
        <p>{t("generation.assetConflict.intro")}</p>
        <p>{assetConflict.rec.output_asset_id} — {assetConflict.latest ? `${t("generation.assetConflict.currentSelection")}: ${Boolean(assetConflict.latest.selected)} (v${assetConflict.latest.selection_version})` : "—"}</p>
        <button onClick={() => void api.state(state.project.id).then((s) => setAssetConflict({ rec: assetConflict.rec, latest: s.assets.find((a) => a.id === assetConflict.rec.output_asset_id) })).catch(props.onError)}>{t("generation.assetConflict.fetchLatest")}</button>
        <button disabled={!assetConflict.latest || busy} onClick={() => void useAsFirstFrame(assetConflict.rec, assetConflict.latest!.selection_version)}>{t("generation.assetConflict.chooseAfterCompare")}</button>
        <button onClick={() => setAssetConflict(null)}>{t("generation.assetConflict.keepSelection")}</button>
      </div>}
      <ModelEnvironmentPanel key={state.project.id} projectId={state.project.id} onSelection={(saved) => { setWorkflowState({ projectId: state.project.id, saved }); if (saved?.selection) setKind(saved.selection.kind); }} />
      <div className="stage-ctx">
        <span className="stage-ctx-label">{t("stage.title")}</span>
        {props.onReview && <button className="link stage-review-link" onClick={props.onReview}>{t("app.review")} ↗</button>}
        <span className="stage-ctx-chips">
          <span key={`v${latest?.version_no ?? "none"}`} className="stat-chip">
            {t("stage.version", { version: latest ? `v${latest.version_no}` : t("stage.notFinalized") })}
          </span>
          <span key={`a${adoptedCount}`} className="stat-chip ok">
            {t("stage.adopted", { count: adoptedCount })}
          </span>
          {pendingTotal > 0 && (
            <span key={`p${pendingTotal}`} className="stat-chip warn">
              {t("stage.pending", { count: pendingTotal })}
            </span>
          )}
          {anyRunning && <span className="stat-chip live">{t("stage.generating")}</span>}
        </span>
        <span className="stage-ctx-tail">
          <span className="stage-ctx-next">
            {guidance.kind === "step" &&
              guidance.step.pane !== "generate" && (
                <button
                  className="link"
                  onClick={() =>
                    props.onSelect(guidance.step.pane, guidance.step.tab)
                  }
                >
                  {t("stage.next", { step: guidance.step.label })} →
                </button>
              )}
          </span>
          <span className="stat-chip" title={t("stage.currentMode")}>
            <Icon name={modeDef(props.mode).icon} /> {t(modeLabelKey(props.mode))}
          </span>
          {meta?.gen_backend === "mock" ? (
            <span
              className="badge mock"
              title={t("stage.mockTitle")}
            >
              MOCK
            </span>
          ) : (
            <span className="badge quiet" title={t("generation.backendTitle")}>
              {meta?.gen_backend ?? "…"}
            </span>
          )}
        </span>
      </div>

      {comparisonMessage && <div role="alert"><p>{t(`generation.comparison.${comparisonMessage}`)}</p><button onClick={reloadComparison}>{t("generation.comparison.reload")}</button></div>}
      <GenerationStageContent
        state={state}
        mode={props.mode}
        generations={gens}
        selected={sel}
        justFinishedId={justFinished}
        selectedVersionNo={sel?.blueprint_version_id ? (versionNoById.get(sel.blueprint_version_id) ?? null) : null}
        retryBlock={sel ? reissueBlock(sel) : null}
        concurrentRunning={anyRunning}
        videoSupported={videoSupported}
        guidance={guidance}
        comparing={comparing}
        compareList={compareList}
        versionNoById={versionNoById}
        onToggleCompare={() =>
          setCompareIds((ids) => (ids === null ? [] : null))
        }
        onSelect={props.onSelect}
        onSelectGeneration={(id) =>
          compareIds !== null ? pickCompare(id) : setSelId(id)
        }
        onReissue={reissue}
        onAmendDoc={props.onAmendDoc}
        onUseAsFirstFrame={(rec) => void useAsFirstFrame(rec)}
        busy={busy}
        onChanged={props.onChanged}
      />

      <details
        className="card gen-controls"
        // remounting on the empty↔has-results boundary lets the
        // controls fold themselves away once the stage has work on it
        key={gens.length === 0 ? "empty" : "has-results"}
        open={gens.length === 0}
      >
        <summary>
          {t("stage.generateFromConditions")}
          <span className="muted small">
            {latest
              ? t("generation.controlsVersion", { version: latest.version_no, kind: t(kindKey(kind)) })
              : t("generation.versionNotFinalized")}
          </span>
        </summary>
        {qwenEdit && (
          <div className="missing-box">
            <p>
              <strong>
                {t("generation.qwenEditTitle")}
              </strong>
            </p>
            <p className="muted small">
              {t("generation.qwenEditDescription")}
            </p>
            <label className="field">
              {t("generation.editSourceRequired")}
              <select
                aria-label={t("generation.editSource")}
                value={editSourceId}
                onChange={(e) =>
                  setEditSource({
                    projectId: state.project.id,
                    assetId: e.target.value,
                  })
                }
              >
                <option value="">{t("generation.selectEditSource")}</option>
                {editSourceChoices.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.id.slice(0, 8)} — {asset.kind} — {asset.mime}
                  </option>
                ))}
              </select>
            </label>
            {editSourceAsset && (
              <div className="gen-result">
                <img
                  src={assetUrl(editSourceAsset.id)}
                  alt={t("generation.selectedEditSourceAlt")}
                />
              </div>
            )}
            {editSourceChoices.length === 0 && (
              <p className="warn-text small">
                {t("generation.noEditSources")}
              </p>
            )}
            <label className="inline-field">
              seed
              <input
                type="number"
                min={0}
                step={1}
                value={editSeed}
                onChange={(e) => setEditSeed(Number(e.target.value))}
              />
            </label>
          </div>
        )}
        {qwenImage && kind === "image" && (
          <div className="missing-box">
            <p>
              <strong>Qwen Image 2.1 Turbo</strong>
            </p>
            <p className="muted small">
              {t("generation.qwenImageDescription")}
            </p>
            <p className="muted small">
              {t("generation.refSize.intro")}
            </p>
            {needsReferenceSize && <div>
              <button disabled={referenceSizeLoading || busy} onClick={() => {
                if (!latest) return;
                setReferenceSizeLoading(true);
                void api.qwenReferenceSize(state.project.id, latest.id)
                  .then((value) => setReferenceSize({ key: referenceKey, value, confirmed: false }))
                  .catch(props.onError).finally(() => setReferenceSizeLoading(false));
              }}>{t("generation.refSize.check")}</button>
              {activeReferenceSize && <label>
                <input type="checkbox" checked={activeReferenceSize.confirmed} onChange={(event) => setReferenceSize({ ...activeReferenceSize, confirmed: event.target.checked })} />
                {t("generation.refSize.select", { width: activeReferenceSize.value.width, height: activeReferenceSize.value.height, sw: activeReferenceSize.value.source_width, sh: activeReferenceSize.value.source_height, rw: activeReferenceSize.value.requested_width ?? "—", rh: activeReferenceSize.value.requested_height ?? "—" })}
              </label>}
            </div>}
          </div>
        )}
        {qwenImage && kind === "video" && (
          <p className="muted small">
            {t("generation.qwenVideoDescription")}
          </p>
        )}
        <div className="kv">
          <span className="kv-k">{t("generation.kindLabel")}</span>
          <span className="kv-v">
            <span className="seg" role="radiogroup" aria-label={t("generation.kindLabel")}>
              <label className={kind === "image" ? "seg-opt on" : "seg-opt"}>
                <input
                  className="seg-input"
                  type="radio"
                  name="gen-kind"
                  checked={kind === "image"}
                  onChange={() => setKind("image")}
                />
                {t(kindKey("image"))}
              </label>
              <label className={kind === "video" ? "seg-opt on" : "seg-opt"}>
                <input
                  className="seg-input"
                  type="radio"
                  name="gen-kind"
                  checked={kind === "video"}
                  disabled={!videoSupported}
                  onChange={() => setKind("video")}
                />
                {t(videoSupported ? kindKey("video") : "generation.videoUnsupported")}
              </label>
            </span>{" "}
            {kind === "video" && (
              <label className="muted inline-field">
                {t("generation.duration")}
                <input
                  type="number"
                  min={0.5}
                  max={15}
                  step={0.5}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                />
              </label>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="kv-k">{t("generation.targetVersion")}</span>
          <span className="kv-v">
            {latest ? (
              <>
                v{latest.version_no}
                <span className="muted">{t("generation.dateParen", { date: latest.created_at })}</span>
              </>
            ) : (
              <span className="muted">{t("generation.versionNotFinalized")}</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="kv-k">{t("generation.referencesForVersion")}</span>
          <span className="kv-v">
            {!shownDetail ? (
              <span className="muted">
                {detailStatus === "error"
                  ? t("generation.blueprintUnavailable")
                  : detailStatus === "loading" || !latest
                  ? t("generation.blueprintLoading")
                    : t("generation.blueprintDifferentVersion")}
              </span>
            ) : snapChars.length === 0 && snapAssetCount === 0 ? (
              <span className="muted">{t("sceneDraft.none")}</span>
            ) : (
              <>
                {snapChars.length > 0 &&
                  `${t("generation.charactersLabel")}: ${snapChars
                    .map(
                      (c) =>
                        `${c.name}${c.revNo != null ? ` ${t("generation.characterVersion", { version: c.revNo })}` : ""}${c.hasBaseImage ? ` (${t("generation.hasReferenceImage")})` : ""}`,
                    )
                    .join(", ")}`}
                {snapChars.length > 0 && snapAssetCount > 0 && " / "}
                {snapAssetCount > 0 && t("generation.selectedAssets", { count: snapAssetCount })}
              </>
            )}
          </span>
        </div>
        {drifted && (
          <p className="muted small">
            <span className="badge recheck">{t("generation.recheck")}</span>{" "}
            {t("generation.blueprintDrift")}
          </p>
        )}
        <div className="kv">
          <span className="kv-k">{t("generation.documentToUse")}</span>
          <span className="kv-v">
            {docChoice.kind === "stale" && (
              <p className="warn-text small">
                <span className="badge recheck">{t("generation.recheck")}</span>{" "}
                {t("generation.documentChanged")}
                {docChoice.pickedRev && (
                  <span className="muted">
                    {t("generation.previousDocumentChoice", { version: docChoice.pickedRev.rev_no })}
                  </span>
                )}
              </p>
            )}
            {docCandidates.length === 0 ? (
              <span className="muted">{t("sceneDraft.none")}</span>
            ) : docCandidates.length === 1 && docChoice.kind !== "stale" ? (
              <>
                {docCandidateLabel(docCandidates[0], t)}
                <span className="muted">{t("generation.approvedDocForVersion")}</span>
              </>
            ) : (
              <div role="radiogroup" aria-label={t("generation.documentToUse")}>
                {docCandidates.map((c) => (
                  <label
                    key={c.rev.id}
                    className="inline-field"
                    style={{ display: "flex", gap: 6 }}
                  >
                    <input
                      type="radio"
                      name="gen-doc"
                      checked={pickedRevId === c.rev.id}
                      onChange={() =>
                        setPick({ key: pickKey, revId: c.rev.id })
                      }
                    />
                    {docCandidateLabel(c, t)}
                  </label>
                ))}
              </div>
            )}
          </span>
        </div>

        {missing.length > 0 && (
          <div className="missing-box">
            <p className="warn-text">{t("generation.missingRequirements")}</p>
            <ul className="check-list">
              {missing.map((r, i) => (
                <li key={i} className="check missing">
                  <span className="check-icon" aria-hidden>
                    ✗
                  </span>
                  <span>
                    {r.label}
                    {r.detail && <div className="muted small">{r.detail}</div>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="row wrap">
              {latest && detailStatus === "error" && (
                <button className="link" onClick={retryDetail}>
                  {t("generation.reloadBlueprint")} →
                </button>
              )}
              <button
                className="link"
                onClick={() =>
                  props.onSelect(
                    "content",
                    missing.some((r) => r.detail === t("readiness.requiredMissingDetail"))
                      ? "items"
                      : "docs",
                  )
                }
              >
                {t("generation.openWorkContent")} →
              </button>
            </div>
          </div>
        )}

        <button
          className="primary primary-block"
          disabled={
            !latest ||
            !selection ||
            busy ||
            anyRunning ||
            !detailMatches ||
            docRevToUse === null ||
            (needsReferenceSize && !activeReferenceSize?.confirmed) ||
            (qwenEdit &&
              (!editSourceAsset ||
                !Number.isSafeInteger(editSeed) ||
                editSeed < 0))
          }
          onClick={() => void generate()}
        >
          {busy
            ? t("generation.submitting")
            : anyRunning
              ? t("generation.running")
              : t("generation.generate", { kind: t(kindKey(kind)) })}
        </button>
        <button
          disabled={draftTargetKey === null || draftBusy}
          onClick={() => void loadSceneDraft()}
        >
          {draftBusy ? t("generation.draftLoading") : t("generation.reviewSceneDraft")}
        </button>
        {shownDraftErr && <p className="warn-text small">{shownDraftErr}</p>}
        {shownSavedDraft ? (
          <SceneDraftCard
            draft={shownSavedDraft.snapshot}
            state={state}
            saved={shownSavedDraft}
          />
        ) : shownDraft ? (
          <SceneDraftCard
            draft={shownDraft}
            state={state}
            saving={draftBusy}
            onSave={() => void saveSceneDraft()}
          />
        ) : null}
        {disabledReason && (
          <p className="muted small">
            {disabledReason}
            {latest &&
              (detailStatus === "error" ||
                (detailStatus === "ready" && !detailMatches)) && (
                <>
                  {" "}
                  <button className="link" onClick={retryDetail}>
                    {t("generation.reloadBlueprint")}
                  </button>
                </>
              )}
          </p>
        )}
        {latest && ready && !disabledReason && (
          <p className="muted small">
            {t("generation.requirementsReady")}
          </p>
        )}
      </details>
    </div>
  );
}
