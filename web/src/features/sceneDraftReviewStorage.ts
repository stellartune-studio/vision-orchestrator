import type { SceneInputDraftReview } from "@vo/shared";

export type LocalReview = {
  projectId: string;
  draftId: string;
  review: SceneInputDraftReview;
  baseVersion: number;
  baseReview: SceneInputDraftReview;
  dirty: boolean;
  newIssueText: string;
  resumeDraftId: string;
  resumeIssueId: string;
  editSerial: number;
};

export type ReviewBackupStatus = "session" | "memory" | "none" | "unavailable" | "clear-failed";

export type ReviewBackupRead = {
  value: LocalReview | null;
  status: ReviewBackupStatus;
};

export interface ReviewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type BackupEntry = {
  revision: number;
  value: LocalReview | null;
};

export function reviewStorageKey(projectId: string, draftId: string) {
  return `vo.scene-draft-review.v1:${encodeURIComponent(projectId)}:${encodeURIComponent(draftId)}`;
}

function isLocalReview(value: unknown, projectId: string, draftId: string): value is LocalReview {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalReview>;
  return candidate.projectId === projectId && candidate.draftId === draftId &&
    !!candidate.review && Array.isArray(candidate.review.items) &&
    Array.isArray(candidate.review.unresolved_issues) &&
    !!candidate.baseReview && Number.isSafeInteger(candidate.baseVersion) &&
    typeof candidate.dirty === "boolean" && typeof candidate.newIssueText === "string" &&
    typeof candidate.resumeDraftId === "string" && typeof candidate.resumeIssueId === "string" &&
    Number.isSafeInteger(candidate.editSerial);
}

function decodeStored(raw: string, projectId: string, draftId: string): BackupEntry | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as { revision?: unknown; value?: unknown };
  if (Number.isSafeInteger(envelope.revision) && isLocalReview(envelope.value, projectId, draftId)) {
    return { revision: envelope.revision as number, value: envelope.value };
  }
  // Keep backups written by the previous raw-value format readable. New writes
  // always use a revisioned envelope so a memory-only edit can supersede it.
  if (isLocalReview(parsed, projectId, draftId)) return { revision: 0, value: parsed };
  return null;
}

export class SceneDraftReviewBackupStore {
  private readonly volatile = new Map<string, BackupEntry>();
  // Only targets whose newest unsaved value exists in memory but not in
  // sessionStorage belong here. Volatile tombstones and successful session
  // backups are deliberately not warning reasons.
  private readonly memoryOnlyUnsaved = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly getStorage: () => ReviewStorage | null;

  constructor(getStorage: () => ReviewStorage | null) {
    this.getStorage = getStorage;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasMemoryOnlyUnsaved(): boolean {
    return this.memoryOnlyUnsaved.size > 0;
  }

  private setMemoryOnlyUnsaved(key: string, unsaved: boolean) {
    let changed = false;
    if (unsaved) {
      if (!this.memoryOnlyUnsaved.has(key)) {
        this.memoryOnlyUnsaved.add(key);
        changed = true;
      }
    } else {
      changed = this.memoryOnlyUnsaved.delete(key);
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  read(projectId: string, draftId: string): ReviewBackupRead {
    const key = reviewStorageKey(projectId, draftId);
    const memory = this.volatile.get(key);
    let stored: BackupEntry | null = null;
    let storageFailed = false;
    try {
      const raw = this.getStorage()?.getItem(key) ?? null;
      if (raw) stored = decodeStored(raw, projectId, draftId);
    } catch {
      storageFailed = true;
    }

    if (memory && (!stored || memory.revision > stored.revision)) {
      return {
        value: memory.value,
        status: memory.value ? "memory" : "clear-failed",
      };
    }
    if (stored) return { value: stored.value, status: "session" };
    if (memory) return { value: memory.value, status: memory.value ? "memory" : "clear-failed" };
    return { value: null, status: storageFailed ? "unavailable" : "none" };
  }

  write(value: LocalReview): ReviewBackupStatus {
    const key = reviewStorageKey(value.projectId, value.draftId);
    const keep = value.dirty || value.newIssueText.length > 0;
    let storedRevision = 0;
    try {
      const raw = this.getStorage()?.getItem(key);
      if (raw) storedRevision = decodeStored(raw, value.projectId, value.draftId)?.revision ?? 0;
    } catch {
      // A wall-clock seed lets a fresh app instance outrank an older tab backup
      // even when storage reads are denied as well as writes.
    }
    this.revision = Math.max(this.revision + 1, Date.now(), storedRevision + 1);
    const entry: BackupEntry = { revision: this.revision, value: keep ? value : null };
    // Install in memory first. Even a successful getItem returning null or an
    // older value cannot roll back a write that failed in this tab.
    this.volatile.set(key, entry);
    if (keep) {
      try {
        const storage = this.getStorage();
        if (!storage) {
          this.setMemoryOnlyUnsaved(key, true);
          return "memory";
        }
        storage.setItem(key, JSON.stringify(entry));
        this.setMemoryOnlyUnsaved(key, false);
        return "session";
      } catch {
        this.setMemoryOnlyUnsaved(key, true);
        return "memory";
      }
    }
    // Saving clean state or explicitly discarding removes the unsaved reason
    // even if removing an older browser copy fails. The tombstone below only
    // suppresses stale restoration in this run; it is not unsaved input.
    this.setMemoryOnlyUnsaved(key, false);
    try {
      const storage = this.getStorage();
      if (!storage) return "clear-failed";
      storage.removeItem(key);
      this.volatile.delete(key);
      return "none";
    } catch {
      // A tombstone prevents old storage content from resurfacing in this run.
      return "clear-failed";
    }
  }
}

export const sceneDraftReviewBackups = new SceneDraftReviewBackupStore(() => {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
});
