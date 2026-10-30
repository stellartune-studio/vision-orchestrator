import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  SceneDraftReviewStatus,
  SceneInputDraft,
  SceneInputDraftReview,
  SceneInputDraftReviewItem,
  SceneInputDraftReviewIssue,
  SceneInputDraftResumeTarget,
  SaveSceneInputDraftReviewRequest,
} from "@vo/shared";
import { transact } from "../db/connection.ts";
import { getSceneInputDraft } from "../repos/sceneInputDrafts.ts";
import {
  getSceneInputDraftReviewRow,
  insertSceneInputDraftReview,
  updateSceneInputDraftReview,
} from "../repos/sceneInputDraftReviews.ts";
import { BadRequestError, ConflictError } from "../repos/errors.ts";

const REVIEW_STATUSES = new Set<SceneDraftReviewStatus>([
  "unconfirmed",
  "in_progress",
  "confirmed",
]);
const MAX_NOTE_CHARS = 10_000;
const MAX_ISSUE_CHARS = 2_000;

interface StoredItem {
  id: string;
  status: SceneDraftReviewStatus;
  answer: string;
  memo: string;
}

interface StoredIssue extends SceneInputDraftReviewIssue {}

interface StoredState {
  items: StoredItem[];
  unresolved_issues: StoredIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function reviewItemId(draftId: string, pointer: string): string {
  // The saved snapshot is immutable. Its JSON Pointer is stable within
  // this draft; including draftId prevents state from carrying to a new draft.
  const hash = createHash("sha256")
    .update(`${draftId}\0${pointer}`)
    .digest("hex")
    .slice(0, 32);
  return `item_${hash}`;
}

function sectionItem(
  draftId: string,
  pointer: string,
  kind: SceneInputDraftReviewItem["kind"],
  label: string,
  sourceText: string,
): SceneInputDraftReviewItem {
  return {
    id: reviewItemId(draftId, pointer),
    pointer,
    kind,
    label,
    source_text: sourceText,
    source_status: null,
    status: "unconfirmed",
    answer: "",
    memo: "",
  };
}

export function deriveSceneDraftReviewItems(
  draftId: string,
  snapshot: SceneInputDraft,
): SceneInputDraftReviewItem[] {
  const items: SceneInputDraftReviewItem[] = [
    sectionItem(draftId, "/scene", "scene", "場面", snapshot.scene.content),
  ];
  snapshot.constraints.forEach((item, index) =>
    items.push(
      sectionItem(
        draftId,
        `/constraints/${index}`,
        "constraint",
        `固定条件 ${index + 1}`,
        item.content,
      ),
    ),
  );
  snapshot.context.forEach((item, index) =>
    items.push(
      sectionItem(
        draftId,
        `/context/${index}`,
        "context",
        `背景 ${index + 1}`,
        item.content,
      ),
    ),
  );
  snapshot.unclassified.forEach((item, index) =>
    items.push(
      sectionItem(
        draftId,
        `/unclassified/${index}`,
        "unclassified",
        `未分類 ${index + 1}`,
        item.content,
      ),
    ),
  );
  snapshot.open_questions.forEach((question, index) => {
    const related = question.related.map((section) => section.content).join("\n");
    items.push({
      ...sectionItem(
        draftId,
        `/open_questions/${index}`,
        "open_question",
        `確認事項: ${question.kind}`,
        [question.note, related].filter(Boolean).join("\n"),
      ),
      source_status: question.status,
    });
  });
  snapshot.unresolved_sources.forEach((unresolved, index) =>
    items.push(
      sectionItem(
        draftId,
        `/unresolved_sources/${index}`,
        "unresolved_source",
        unresolved.source.label ?? "未解決の参照",
        `${unresolved.source.kind}: ${unresolved.source.id} (${unresolved.reason})`,
      ),
    ),
  );
  snapshot.uninspected_sources.forEach((source, index) =>
    items.push(
      sectionItem(
        draftId,
        `/uninspected_sources/${index}`,
        "uninspected_source",
        source.label ?? "未検査の出典",
        `${source.kind}: ${source.id}`,
      ),
    ),
  );
  return items;
}

function parseStoredState(row: ReturnType<typeof getSceneInputDraftReviewRow>): StoredState {
  if (!row) return { items: [], unresolved_issues: [] };
  const value = JSON.parse(row.state_json) as unknown;
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.unresolved_issues)
  ) {
    throw new Error("stored scene draft review state is malformed");
  }
  return value as unknown as StoredState;
}

function composeReview(
  projectId: string,
  draftId: string,
  snapshot: SceneInputDraft,
  row: ReturnType<typeof getSceneInputDraftReviewRow>,
): SceneInputDraftReview {
  const stored = parseStoredState(row);
  const values = new Map(stored.items.map((item) => [item.id, item]));
  const items = deriveSceneDraftReviewItems(draftId, snapshot).map((item) => {
    const value = values.get(item.id);
    return value
      ? { ...item, status: value.status, answer: value.answer, memo: value.memo }
      : item;
  });
  return {
    project_id: projectId,
    draft_id: draftId,
    version: row?.version ?? 0,
    persisted: !!row,
    updated_at: row?.updated_at ?? null,
    items,
    unresolved_issues: stored.unresolved_issues,
    resume_target:
      row?.resume_draft_id && row.resume_issue_id
        ? { draft_id: row.resume_draft_id, issue_id: row.resume_issue_id }
        : null,
  };
}

export function getSceneInputDraftReview(
  db: DatabaseSync,
  projectId: string,
  draftId: string,
): SceneInputDraftReview {
  const record = getSceneInputDraft(db, projectId, draftId);
  const row = getSceneInputDraftReviewRow(db, projectId, draftId);
  return composeReview(projectId, draftId, record.snapshot, row);
}

function validateIssueId(id: unknown): id is string {
  return typeof id === "string" && /^issue_[A-Za-z0-9_-]{8,96}$/.test(id);
}

function validStatus(value: unknown): value is SceneDraftReviewStatus {
  return typeof value === "string" && REVIEW_STATUSES.has(value as SceneDraftReviewStatus);
}

function validateNote(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > MAX_NOTE_CHARS) {
    throw new BadRequestError(`${name} must be text of at most ${MAX_NOTE_CHARS} characters`);
  }
  return value;
}

function validateSaveBody(value: unknown): SaveSceneInputDraftReviewRequest {
  if (!isRecord(value) || !exactKeys(value, [
    "expected_version", "items", "unresolved_issues", "resume_target",
  ])) {
    throw new BadRequestError("review save body has an invalid shape");
  }
  if (!Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 0) {
    throw new BadRequestError("expected_version must be a non-negative integer");
  }
  if (!Array.isArray(value.items) || !Array.isArray(value.unresolved_issues)) {
    throw new BadRequestError("items and unresolved_issues must be arrays");
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ["id", "status", "answer", "memo"])) {
      throw new BadRequestError("review item has an invalid shape");
    }
    if (typeof item.id !== "string" || !validStatus(item.status)) {
      throw new BadRequestError("review item id or status is invalid");
    }
    const answer = validateNote(item.answer, "answer");
    const memo = validateNote(item.memo, "memo");
    return {
      id: item.id,
      status: item.status,
      answer,
      memo,
    };
  });
  const unresolved_issues = value.unresolved_issues.map((issue) => {
    if (!isRecord(issue) || !exactKeys(issue, ["id", "text", "status", "answer", "memo"])) {
      throw new BadRequestError("unresolved issue has an invalid shape");
    }
    if (!validateIssueId(issue.id) || !validStatus(issue.status)) {
      throw new BadRequestError("unresolved issue id or status is invalid");
    }
    if (typeof issue.text !== "string" || !issue.text.trim() || issue.text.length > MAX_ISSUE_CHARS) {
      throw new BadRequestError(`unresolved issue text must be 1-${MAX_ISSUE_CHARS} characters`);
    }
    const answer = validateNote(issue.answer, "issue answer");
    const memo = validateNote(issue.memo, "issue memo");
    return {
      id: issue.id,
      text: issue.text,
      status: issue.status,
      answer,
      memo,
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new BadRequestError("review item ids must be unique");
  }
  if (new Set(unresolved_issues.map((issue) => issue.id)).size !== unresolved_issues.length) {
    throw new BadRequestError("unresolved issue ids must be unique");
  }
  let resume_target: SceneInputDraftResumeTarget | null = null;
  if (value.resume_target !== null) {
    if (
      !isRecord(value.resume_target) ||
      !exactKeys(value.resume_target, ["draft_id", "issue_id"]) ||
      typeof value.resume_target.draft_id !== "string" ||
      typeof value.resume_target.issue_id !== "string"
    ) {
      throw new BadRequestError("resume_target must contain draft_id and issue_id");
    }
    resume_target = {
      draft_id: value.resume_target.draft_id,
      issue_id: value.resume_target.issue_id,
    };
  }
  return {
    expected_version: Number(value.expected_version),
    items,
    unresolved_issues,
    resume_target,
  };
}

function validateResumeTarget(
  db: DatabaseSync,
  projectId: string,
  currentDraftId: string,
  target: SceneInputDraftResumeTarget | null,
  currentUnresolvedIssues: SceneInputDraftReviewIssue[],
): void {
  if (!target) return;
  const targetRecord = getSceneInputDraft(db, projectId, target.draft_id);
  const systemItems = deriveSceneDraftReviewItems(
    target.draft_id,
    targetRecord.snapshot,
  );
  const validIds = new Set(systemItems.map((item) => item.id));
  if (target.draft_id === currentDraftId) {
    for (const issue of currentUnresolvedIssues) validIds.add(issue.id);
  } else {
    const targetRow = getSceneInputDraftReviewRow(db, projectId, target.draft_id);
    for (const issue of parseStoredState(targetRow).unresolved_issues) validIds.add(issue.id);
  }
  if (!validIds.has(target.issue_id)) {
    throw new BadRequestError("resume target issue does not belong to that saved draft");
  }
}

export function saveSceneInputDraftReview(
  db: DatabaseSync,
  projectId: string,
  draftId: string,
  body: unknown,
): SceneInputDraftReview {
  const request = validateSaveBody(body);
  return transact(db, () => {
    const record = getSceneInputDraft(db, projectId, draftId);
    const row = getSceneInputDraftReviewRow(db, projectId, draftId);
    const currentVersion = row?.version ?? 0;
    if (request.expected_version !== currentVersion) {
      throw new ConflictError("review changed since it was loaded; reload or merge before saving");
    }
    const baseItems = deriveSceneDraftReviewItems(draftId, record.snapshot);
    const expectedIds = new Set(baseItems.map((item) => item.id));
    const submittedIds = new Set(request.items.map((item) => item.id));
    if (
      expectedIds.size !== submittedIds.size ||
      [...expectedIds].some((id) => !submittedIds.has(id))
    ) {
      throw new BadRequestError("review items must match the selected saved draft");
    }
    validateResumeTarget(
      db,
      projectId,
      draftId,
      request.resume_target,
      request.unresolved_issues,
    );
    const state: StoredState = {
      items: request.items,
      unresolved_issues: request.unresolved_issues,
    };
    if (row) {
      const updated = updateSceneInputDraftReview(db, {
        project_id: projectId,
        draft_id: draftId,
        expected_version: request.expected_version,
        state_json: JSON.stringify(state),
        resume_target: request.resume_target,
      });
      if (!updated) {
        throw new ConflictError("review changed since it was loaded; reload or merge before saving");
      }
    } else {
      if (request.expected_version !== 0) {
        throw new ConflictError("review changed since it was loaded; reload or merge before saving");
      }
      insertSceneInputDraftReview(db, {
        project_id: projectId,
        draft_id: draftId,
        state_json: JSON.stringify(state),
        resume_target: request.resume_target,
      });
    }
    const savedRow = getSceneInputDraftReviewRow(db, projectId, draftId);
    return composeReview(projectId, draftId, record.snapshot, savedRow);
  });
}
