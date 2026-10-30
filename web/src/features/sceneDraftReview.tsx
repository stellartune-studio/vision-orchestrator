import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  SceneInputDraftRecord,
  SceneInputDraftReview,
  SceneInputDraftReviewItem,
  SceneInputDraftReviewIssue,
  SceneInputDraftSummary,
  SaveSceneInputDraftReviewRequest,
} from "@vo/shared";
import { api, describeError } from "../api/client.ts";
import { useI18n } from "../i18n.tsx";
import {
  sceneDraftReviewBackups,
  type ReviewBackupStatus,
  type LocalReview,
} from "./sceneDraftReviewStorage.ts";
import { ReviewFields, ReviewItemEditor } from "./sceneDraftReviewFields.tsx";

type Props = {
  projectId: string;
  saved: SceneInputDraftRecord;
  drafts: SceneInputDraftSummary[];
};

type ReviewConflict = {
  latest: SceneInputDraftReview | null;
  selected: "local" | "latest" | null;
  fetched: boolean;
};

function reviewForSave(review: SceneInputDraftReview, expectedVersion: number): SaveSceneInputDraftReviewRequest {
  return {
    expected_version: expectedVersion,
    items: review.items.map(({ id, status, answer, memo }) => ({ id, status, answer, memo })),
    unresolved_issues: review.unresolved_issues,
    resume_target: review.resume_target,
  };
}

function issueOptions(review: SceneInputDraftReview, t: (key: string, values?: Record<string, string | number>) => string) {
  return [
    ...review.items.map((item) => ({ id: item.id, label: item.label })),
    ...review.unresolved_issues.map((issue) => ({
      id: issue.id,
      label: t("sceneReview.unresolvedIssue", { text: issue.text }),
    })),
  ];
}

function updateItem(
  items: SceneInputDraftReviewItem[],
  id: string,
  patch: Partial<Pick<SceneInputDraftReviewItem, "status" | "answer" | "memo">>,
) {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

function updateIssue(
  issues: SceneInputDraftReviewIssue[],
  id: string,
  patch: Partial<Pick<SceneInputDraftReviewIssue, "text" | "status" | "answer" | "memo">>,
) {
  return issues.map((issue) => (issue.id === id ? { ...issue, ...patch } : issue));
}

export function SceneDraftReviewPanel({ projectId, saved, drafts }: Props) {
  const { t } = useI18n();
  const latestT = useRef(t);
  latestT.current = t;
  const draftId = saved.id;
  const targetKey = `${projectId}:${draftId}`;
  const targetRef = useRef(targetKey);
  const editSerial = useRef(0);
  const saveInFlight = useRef(false);
  const refreshInFlight = useRef(false);
  const [review, setReview] = useState<SceneInputDraftReview | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const [baseReview, setBaseReview] = useState<SceneInputDraftReview | null>(null);
  const [conflict, setConflict] = useState<ReviewConflict | null>(null);
  const [restored, setRestored] = useState(false);
  const [backupStatus, setBackupStatus] = useState<ReviewBackupStatus>("none");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newIssueText, setNewIssueText] = useState("");
  const [resumeDraftId, setResumeDraftId] = useState("");
  const [resumeIssueId, setResumeIssueId] = useState("");
  const [resumeOptions, setResumeOptions] = useState<
    Array<{ id: string; label: string }>
  >([]);

  useEffect(() => {
    let active = true;
    targetRef.current = targetKey;
    setReview(null);
    setDirty(false);
    setError(null);
    setLoading(true);
    setBaseVersion(0);
    setResumeDraftId("");
    setResumeIssueId("");
    editSerial.current = 0;
    api
      .sceneInputDraftReview(projectId, draftId)
      .then((result) => {
        if (!active || targetRef.current !== targetKey) return;
        if (result.project_id !== projectId || result.draft_id !== draftId) {
          throw new Error(latestT.current("sceneReview.targetMismatch"));
        }
        const backup = sceneDraftReviewBackups.read(projectId, draftId);
        const local = backup.value;
        setBackupStatus(backup.status);
        setBaseReview(local?.baseReview ?? result);
        setBaseVersion(local?.baseVersion ?? result.version);
        if (local) {
          setReview(local.review);
          setDirty(local.dirty);
          setNewIssueText(local.newIssueText);
          setResumeDraftId(local.resumeDraftId);
          setResumeIssueId(local.resumeIssueId);
          editSerial.current = local.editSerial;
          setRestored(true);
          if (local.baseVersion !== result.version) {
            setConflict({ latest: result, selected: null, fetched: true });
            setError(latestT.current("sceneReview.versionChanged"));
          }
        } else {
          setReview(result);
          setResumeDraftId(result.resume_target?.draft_id ?? "");
          setResumeIssueId(result.resume_target?.issue_id ?? "");
        }
      })
      .catch((cause) => {
        if (active && targetRef.current === targetKey) {
          setError(`${latestT.current("sceneReview.loadFailed")}: ${describeError(cause)}`);
        }
      })
      .finally(() => {
        if (active && targetRef.current === targetKey) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, draftId, targetKey]);

  useLayoutEffect(() => {
    if (!review || loading) return;
    setBackupStatus(sceneDraftReviewBackups.write({
      projectId,
      draftId,
      review,
      baseVersion,
      baseReview: baseReview ?? review,
      dirty,
      newIssueText,
      resumeDraftId,
      resumeIssueId,
      editSerial: editSerial.current,
    }));
  }, [projectId, draftId, review, baseVersion, baseReview, dirty, newIssueText, resumeDraftId, resumeIssueId, loading]);

  useEffect(() => {
    let active = true;
    if (!resumeDraftId || !review) {
      setResumeOptions([]);
      return () => {
        active = false;
      };
    }
    if (resumeDraftId === draftId) {
      setResumeOptions(issueOptions(review, latestT.current));
      return () => {
        active = false;
      };
    }
    api
      .sceneInputDraftReview(projectId, resumeDraftId)
      .then((targetReview) => {
        if (
          active &&
          targetRef.current === targetKey &&
          targetReview.project_id === projectId &&
          targetReview.draft_id === resumeDraftId
        ) {
          setResumeOptions(issueOptions(targetReview, latestT.current));
        }
      })
      .catch(() => {
        if (active && targetRef.current === targetKey) setResumeOptions([]);
      });
    return () => {
      active = false;
    };
  }, [projectId, draftId, resumeDraftId, review, targetKey]);

  const markDirty = () => {
    editSerial.current += 1;
    setDirty(true);
    setError(null);
  };

  const hasReviewChanges = (candidate: SceneInputDraftReview | null) => {
    if (!candidate || !baseReview) return false;
    return JSON.stringify({
      items: candidate.items.map(({ id, status, answer, memo }) => ({ id, status, answer, memo })),
      unresolved_issues: candidate.unresolved_issues,
      resume_target: candidate.resume_target,
    }) !== JSON.stringify({
      items: baseReview.items.map(({ id, status, answer, memo }) => ({ id, status, answer, memo })),
      unresolved_issues: baseReview.unresolved_issues,
      resume_target: baseReview.resume_target,
    });
  };

  const changeItem = (
    id: string,
    patch: Partial<Pick<SceneInputDraftReviewItem, "status" | "answer" | "memo">>,
  ) => {
    markDirty();
    setReview((current) =>
      current ? { ...current, items: updateItem(current.items, id, patch) } : current,
    );
  };

  const changeIssue = (
    id: string,
    patch: Partial<Pick<SceneInputDraftReviewIssue, "text" | "status" | "answer" | "memo">>,
  ) => {
    markDirty();
    setReview((current) =>
      current
        ? {
            ...current,
            unresolved_issues: updateIssue(current.unresolved_issues, id, patch),
          }
        : current,
    );
  };

  const addIssue = () => {
    const text = newIssueText.trim();
    if (!review || !text) return;
    const issue: SceneInputDraftReviewIssue = {
      id: `issue_${globalThis.crypto.randomUUID()}`,
      text,
      status: "unconfirmed",
      answer: "",
      memo: "",
    };
    markDirty();
    setReview({ ...review, unresolved_issues: [...review.unresolved_issues, issue] });
    setNewIssueText("");
  };

  const changeResumeDraft = (nextDraftId: string) => {
    markDirty();
    setResumeDraftId(nextDraftId);
    setResumeIssueId("");
    setReview((current) => current ? { ...current, resume_target: null } : current);
  };

  const changeResumeIssue = (issueId: string) => {
    markDirty();
    setResumeIssueId(issueId);
    setReview((current) =>
      current
        ? {
            ...current,
            resume_target:
              resumeDraftId && issueId
                ? { draft_id: resumeDraftId, issue_id: issueId }
                : null,
          }
        : current,
    );
  };

  const save = async () => {
    if (!review || saveInFlight.current || !hasReviewChanges(review)) return;
    if (conflict && (!conflict.fetched || !conflict.latest || conflict.selected !== "local")) {
      setError(t("sceneReview.chooseVersionBeforeSave"));
      return;
    }
    if (resumeDraftId && !resumeIssueId) {
      setError(t("sceneReview.chooseResumeIssue"));
      return;
    }
    const sentSerial = editSerial.current;
    const sentTarget = targetKey;
    const expectedVersion = conflict?.selected === "local" && conflict.latest
      ? conflict.latest.version
      : baseVersion;
    const body: SaveSceneInputDraftReviewRequest = reviewForSave(review, expectedVersion);
    saveInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api.saveSceneInputDraftReview(
        projectId,
        draftId,
        body,
      );
      if (targetRef.current !== sentTarget) return;
      if (
        result.project_id !== projectId ||
        result.draft_id !== draftId ||
        result.version !== expectedVersion + 1 ||
        !result.persisted
      ) {
        throw new Error(t("sceneReview.saveTargetMismatch"));
      }
      setBaseVersion(result.version);
      setBaseReview(result);
      setConflict(null);
      if (editSerial.current === sentSerial && !newIssueText.trim()) {
        setReview(result);
        setDirty(false);
        setResumeDraftId(result.resume_target?.draft_id ?? "");
        setResumeIssueId(result.resume_target?.issue_id ?? "");
      } else {
        // Edits made while the request was in flight remain local and unsaved.
        setDirty(true);
      }
    } catch (cause) {
      if (targetRef.current === sentTarget) {
        const status = (cause as { status?: number })?.status;
        if (status === 409) setConflict({ latest: null, selected: null, fetched: false });
        setError(
          status === 409
            ? t("sceneReview.conflict")
            : `${t("sceneReview.saveFailed")}: ${describeError(cause)}`,
        );
      }
    } finally {
      saveInFlight.current = false;
      if (targetRef.current === sentTarget) setBusy(false);
    }
  };

  const refreshConflict = async () => {
    if (refreshInFlight.current) return;
    const sentTarget = targetKey;
    refreshInFlight.current = true;
    setConflict({ latest: null, selected: null, fetched: false });
    setError(null);
    try {
      const latest = await api.sceneInputDraftReview(projectId, draftId);
      if (targetRef.current !== sentTarget) return;
      if (latest.project_id !== projectId || latest.draft_id !== draftId) {
        throw new Error(t("sceneReview.latestTargetMismatch"));
      }
      setConflict({ latest, selected: null, fetched: true });
      setError(null);
    } catch (cause) {
      if (targetRef.current === sentTarget) {
        setError(`${t("sceneReview.refreshFailed")}: ${describeError(cause)}`);
      }
    } finally {
      refreshInFlight.current = false;
    }
  };

  const chooseConflict = (choice: "local" | "latest") => {
    if (!conflict || !conflict.fetched || !conflict.latest) return;
    if (choice === "latest") {
      setReview(conflict.latest);
      setResumeDraftId(conflict.latest.resume_target?.draft_id ?? "");
      setResumeIssueId(conflict.latest.resume_target?.issue_id ?? "");
      setBaseReview(conflict.latest);
      setBaseVersion(conflict.latest.version);
      setDirty(false);
      setNewIssueText("");
      setConflict(null);
      setRestored(false);
      setError(t("sceneReview.latestApplied"));
      return;
    }
    setConflict({ ...conflict, selected: choice });
    setError(null);
  };

  const discardLocal = () => {
    if (!globalThis.confirm(t("sceneReview.discardConfirm"))) return;
    const next = conflict?.latest ?? baseReview;
    if (next) {
      setReview(next);
      setBaseReview(next);
      setBaseVersion(next.version);
      setResumeDraftId(next.resume_target?.draft_id ?? "");
      setResumeIssueId(next.resume_target?.issue_id ?? "");
    }
    setDirty(false);
    setNewIssueText("");
    setConflict(null);
    setRestored(false);
    const status = sceneDraftReviewBackups.write({
      projectId,
      draftId,
      review: next ?? review!,
      baseVersion: next?.version ?? baseVersion,
      baseReview: next ?? baseReview ?? review!,
      dirty: false,
      newIssueText: "",
      resumeDraftId: next?.resume_target?.draft_id ?? "",
      resumeIssueId: next?.resume_target?.issue_id ?? "",
      editSerial: editSerial.current,
    });
    setBackupStatus(status);
    if (status === "clear-failed") {
      setError(t("sceneReview.clearBackupFailed"));
    } else {
      setError(null);
    }
  };

  const currentSummary = drafts.find((item) => item.id === draftId) ?? saved;
  const resumeIncomplete = !!resumeDraftId && !resumeIssueId;

  return (
    <section className="scene-review" aria-label={t("sceneReview.title")}>
      <div className="row wrap">
        <h4>{t("sceneReview.title")}</h4>
        {review && (
          <span className={dirty ? "badge recheck" : "badge quiet"}>
            {dirty || newIssueText ? t("sceneReview.unsavedInput") : review.persisted ? t("sceneReview.savedVersion", { version: review.version }) : t("sceneReview.unsaved")}
          </span>
        )}
      </div>
      <p className="muted small">
        {t("sceneReview.intro")}
      </p>
      <p className="muted small">{t("sceneReview.storageInfo")}</p>
      {backupStatus === "memory" && <p className="warn-text small">{t("sceneReview.backupMemory")}</p>}
      {backupStatus === "unavailable" && <p className="warn-text small">{t("sceneReview.backupUnavailable")}</p>}
      {backupStatus === "clear-failed" && <p className="warn-text small">{t("sceneReview.backupClearFailed")}</p>}
      {restored && dirty && <p className="warn-text small">{t("sceneReview.restoredUnsaved")}</p>}
      {(dirty || newIssueText) && <button type="button" onClick={discardLocal}>{t("sceneReview.discard")}</button>}
      {loading && <p className="muted">{t("sceneReview.loading")}</p>}
      {error && <p role="alert" className="warn-text small">{error}</p>}
      {review && (
        <>
          {review.items.map((item) => (
            <ReviewItemEditor
              key={item.id}
              item={item}
              onChange={(patch) => changeItem(item.id, patch)}
            />
          ))}

          <div className="scene-review-issues">
            <h5>{t("sceneReview.unresolvedIssues")}</h5>
            {review.unresolved_issues.map((issue) => (
              <div className="scene-review-item" key={issue.id}>
                <label>
                  {t("sceneReview.issue")}
                  <textarea
                    aria-label={t("sceneReview.issueNumber", { id: issue.id })}
                    value={issue.text}
                    onChange={(event) => changeIssue(issue.id, { text: event.target.value })}
                  />
                </label>
                <ReviewFields
                  label={t("sceneReview.issueNumber", { id: issue.id })}
                  status={issue.status}
                  answer={issue.answer}
                  memo={issue.memo}
                  onChange={(patch) => changeIssue(issue.id, patch)}
                />
              </div>
            ))}
            <label>
              {t("sceneReview.addIssueLabel")}
              <textarea
                aria-label={t("sceneReview.addIssueLabel")}
                value={newIssueText}
                onChange={(event) => {
                  markDirty();
                  setNewIssueText(event.target.value);
                }}
              />
            </label>
            {newIssueText && <p className="warn-text small">{t("sceneReview.unaddedIssue")}</p>}
            <button
              type="button"
              disabled={!newIssueText.trim()}
              onClick={addIssue}
            >
              {t("sceneReview.addIssue")}
            </button>
          </div>

          {conflict && (
            <section className="scene-review-conflict" aria-label={t("sceneReview.conflictTitle")}>
              <h5>{t("sceneReview.conflictTitle")}</h5>
              <p role="status">{t("sceneReview.versionComparison", { local: baseVersion, latest: conflict.fetched && conflict.latest ? t("sceneReview.latestVersion", { version: conflict.latest.version }) : t("sceneReview.latestNotFetched") })}</p>
              <button type="button" disabled={refreshInFlight.current} onClick={() => void refreshConflict()}>
                {t("sceneReview.fetchAndCompare")}
              </button>
              <div className="row wrap">
                <button type="button" disabled={!conflict.fetched || !conflict.latest} onClick={() => chooseConflict("local")}>{t("sceneReview.chooseLocal")}</button>
                <button type="button" disabled={!conflict.fetched || !conflict.latest} onClick={() => chooseConflict("latest")}>{t("sceneReview.replaceWithLatest")}</button>
              </div>
              {conflict.fetched && conflict.latest && <div className="scene-review-compare">
                <div><strong>{t("sceneReview.localInput")}</strong><pre>{JSON.stringify(reviewForSave(review, baseVersion), null, 2)}</pre></div>
                <div><strong>{t("sceneReview.fetchedLatest", { version: conflict.latest.version })}</strong><pre>{JSON.stringify(conflict.latest, null, 2)}</pre></div>
              </div>}
              {!conflict.fetched && <p className="warn-text small">{t("sceneReview.latestNotFetchedKeepLocal")}</p>}
              {conflict.selected === "local" && <p>{t("sceneReview.localSelected", { version: conflict.latest?.version ?? "?" })}</p>}
            </section>
          )}

          <div className="scene-review-resume">
            <h5>{t("sceneReview.resumeAt")}</h5>
            <label>
              {t("sceneReview.direction")}
              <select
                aria-label={t("sceneReview.resumeDirection")}
                value={resumeDraftId}
                onChange={(event) => changeResumeDraft(event.target.value)}
              >
                <option value="">{t("sceneReview.notSet")}</option>
                {drafts.some((item) => item.id === draftId) ? null : (
                  <option value={draftId}>{currentSummary.document_id} ({t("sceneReview.thisDirection")})</option>
                )}
                {drafts.map((item) => (
                  <option value={item.id} key={item.id}>
                    {t("sceneReview.documentAndBlueprint", { document: item.document_revision_id.slice(0, 8), blueprint: item.blueprint_version_id.slice(0, 8) })}
                  </option>
                ))}
              </select>
            </label>
            {resumeDraftId && (
              <label>
                {t("sceneReview.issue")}
                <select
                  aria-label={t("sceneReview.resumeIssue")}
                  value={resumeIssueId}
                  onChange={(event) => changeResumeIssue(event.target.value)}
                >
                  <option value="">{t("sceneReview.selectIssue")}</option>
                  {resumeOptions.map((option) => (
                    <option value={option.id} key={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
            {resumeIncomplete && <p className="warn-text small">{t("sceneReview.resumeIssueRequired")}</p>}
          </div>

          <button
            className="primary"
            type="button"
            disabled={loading || busy || !hasReviewChanges(review) || resumeIncomplete || (!!conflict && (!conflict.fetched || !conflict.latest || conflict.selected !== "local"))}
            onClick={() => void save()}
          >
            {busy ? t("sceneReview.saving") : conflict?.selected === "local" ? t("sceneReview.saveLocalFromVersion", { version: conflict.latest?.version ?? "?" }) : t("sceneReview.save")}
          </button>
          <p className="muted small">
            {t("sceneReview.saveHint")}
          </p>
        </>
      )}
    </section>
  );
}
