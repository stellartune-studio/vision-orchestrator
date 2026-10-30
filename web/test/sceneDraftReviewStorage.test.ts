import test from "node:test";
import assert from "node:assert/strict";
import type { SceneInputDraftReview } from "@vo/shared";
import {
  reviewStorageKey,
  SceneDraftReviewBackupStore,
  type LocalReview,
  type ReviewStorage,
} from "../src/features/sceneDraftReviewStorage.ts";

function review(projectId: string, draftId: string, answer = "answer"): SceneInputDraftReview {
  return {
    project_id: projectId,
    draft_id: draftId,
    version: 1,
    persisted: true,
    updated_at: null,
    items: [{
      id: "item-1", pointer: "/scene", kind: "scene", label: "scene",
      source_text: "source", source_status: null, status: "in_progress", answer, memo: "memo",
    }],
    unresolved_issues: [],
    resume_target: null,
  };
}

function local(projectId: string, draftId: string, answer: string, newIssueText = ""): LocalReview {
  const value = review(projectId, draftId, answer);
  return {
    projectId, draftId, review: value, baseVersion: 1, baseReview: value,
    dirty: true, newIssueText, resumeDraftId: "", resumeIssueId: "", editSerial: 1,
  };
}

class MemoryStorage implements ReviewStorage {
  values = new Map<string, string>();
  failGet = false;
  failSet = false;
  failRemove = false;
  getItem(key: string) {
    if (this.failGet) throw new Error("get denied");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failSet) throw new Error("quota exceeded");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.failRemove) throw new Error("remove denied");
    this.values.delete(key);
  }
}

test("memory-only newest backup wins when failed write is followed by null or old session data", () => {
  for (const oldStoredValue of [null, "older"]) {
    const storage = new MemoryStorage();
    const store = new SceneDraftReviewBackupStore(() => storage);
    const key = reviewStorageKey("project-a", "draft-a");
    if (oldStoredValue === "older") {
      storage.values.set(key, JSON.stringify(local("project-a", "draft-a", "old")));
    }
    storage.failSet = true;
    assert.equal(store.write(local("project-a", "draft-a", "new")), "memory");
    assert.equal(store.read("project-a", "draft-a").value?.review.items[0]?.answer, "new");
  }
});

test("storage exceptions preserve target-scoped memory and reject cross-target reuse", () => {
  const storage = new MemoryStorage();
  const store = new SceneDraftReviewBackupStore(() => storage);
  storage.failGet = true;
  storage.failSet = true;
  assert.equal(store.write(local("project-a", "draft-a", "protected")), "memory");
  assert.equal(store.read("project-a", "draft-a").value?.review.items[0]?.answer, "protected");
  assert.equal(store.read("project-b", "draft-a").value, null);
  assert.equal(store.read("project-a", "draft-b").value, null);
});

test("failed removal installs a same-run tombstone and successful removal clears the backup", () => {
  const storage = new MemoryStorage();
  const store = new SceneDraftReviewBackupStore(() => storage);
  const oldValue = local("project-a", "draft-a", "old");
  const key = reviewStorageKey(oldValue.projectId, oldValue.draftId);
  storage.values.set(key, JSON.stringify(oldValue));
  storage.failRemove = true;
  assert.equal(store.write({ ...oldValue, dirty: false }), "clear-failed");
  assert.equal(store.read(oldValue.projectId, oldValue.draftId).value, null);
  storage.failRemove = false;
  assert.equal(store.write({ ...oldValue, dirty: false }), "none");
  assert.equal(store.read(oldValue.projectId, oldValue.draftId).value, null);
  assert.equal(storage.getItem(key), null, "successful clear removes the stale persisted copy");
});

test("memory-only warning tracks unsaved targets independently from stored backups and tombstones", () => {
  const storage = new MemoryStorage();
  const store = new SceneDraftReviewBackupStore(() => storage);
  const changes: boolean[] = [];
  const unsubscribe = store.subscribe(() => changes.push(store.hasMemoryOnlyUnsaved()));

  storage.failSet = true;
  assert.equal(store.write(local("project-a", "draft-a", "memory-a")), "memory");
  assert.equal(store.hasMemoryOnlyUnsaved(), true);
  assert.deepEqual(changes, [true]);

  // A second target keeps the global warning active when the first one is
  // successfully persisted or cleaned.
  assert.equal(store.write(local("project-b", "draft-b", "memory-b")), "memory");
  assert.equal(store.hasMemoryOnlyUnsaved(), true);
  storage.failSet = false;
  assert.equal(store.write(local("project-a", "draft-a", "persisted-a")), "session");
  assert.equal(store.hasMemoryOnlyUnsaved(), true);
  assert.equal(store.write({ ...local("project-b", "draft-b", "memory-b"), dirty: false }), "none");
  assert.equal(store.hasMemoryOnlyUnsaved(), false);
  assert.deepEqual(changes, [true, true, true, false]);

  // Session backups are still restored but do not activate an unload warning.
  assert.equal(store.read("project-a", "draft-a").status, "session");
  assert.equal(store.hasMemoryOnlyUnsaved(), false);
  unsubscribe();
});

test("discard clears warning even when stale browser storage cannot be removed", () => {
  const storage = new MemoryStorage();
  const store = new SceneDraftReviewBackupStore(() => storage);
  storage.failSet = true;
  const input = local("project-a", "draft-a", "unsaved");
  assert.equal(store.write(input), "memory");
  storage.failRemove = true;
  assert.equal(store.write({ ...input, dirty: false }), "clear-failed");
  assert.equal(store.hasMemoryOnlyUnsaved(), false);
  assert.equal(store.read(input.projectId, input.draftId).value, null);
});
