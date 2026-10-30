import { useCallback, useRef, useState } from "react";
import type { ProjectState, WorkbenchBackdrop } from "@vo/shared";
import { api } from "../api/client.ts";

export type BackgroundSaveFailure = "failed" | "conflict";

export interface WorkbenchBackgroundState {
  /** currently selected backdrop key */
  backdropKey: WorkbenchBackdrop;
  /** pending selection + lock — what a save would write */
  locked: boolean;
  /** persisted selection + lock — what a reload restores */
  savedBackdropKey: WorkbenchBackdrop;
  savedLocked: boolean;
  dirty: boolean;
  busy: boolean;
  saveFailure: BackgroundSaveFailure | null;
  select: (key: WorkbenchBackdrop) => void;
  setLocked: (locked: boolean) => void;
  save: () => void;
  /** drop the pending edit and take the latest persisted values */
  discardDraft: () => void;
}

// Drafts survive the full studio remount a project switch triggers.
const bgMemory = new Map<
  string,
  {
    backdropKey: WorkbenchBackdrop;
    locked: boolean;
    failure: BackgroundSaveFailure | null;
  }
>();

/**
 * Connection seam for the scene tab's backdrop selection and pin.
 * The saved pair comes from `state.workbench_background`; selecting or
 * (un)pinning only edits a local draft — nothing is written until the
 * explicit save, and every save carries `expected_version` so a stale
 * screen gets a 409 + kept draft instead of a silent overwrite.
 */
export function useWorkbenchBackground(
  state: ProjectState,
  onChanged: () => Promise<void>,
  onError: (e: unknown) => void,
  fallbackKey: WorkbenchBackdrop,
): WorkbenchBackgroundState {
  const saved = state.workbench_background;
  const savedKey = saved?.backdrop_key ?? fallbackKey;
  const savedLocked = saved?.locked ?? false;
  const pid = state.project.id;
  const [draft, setDraftState] = useState<{
    backdropKey: WorkbenchBackdrop;
    locked: boolean;
    failure: BackgroundSaveFailure | null;
  } | null>(() => bgMemory.get(pid) ?? null);
  const setDraft = useCallback(
    (
      v: {
        backdropKey: WorkbenchBackdrop;
        locked: boolean;
        failure: BackgroundSaveFailure | null;
      } | null,
    ) => {
      if (v) bgMemory.set(pid, v);
      else bgMemory.delete(pid);
      setDraftState(v);
    },
    [pid],
  );
  const [busy, setBusy] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const backdropKey = draft?.backdropKey ?? savedKey;
  const locked = draft?.locked ?? savedLocked;
  const saveFailure = draft?.failure ?? null;
  const dirty =
    draft !== null &&
    (draft.backdropKey !== savedKey || draft.locked !== savedLocked);

  const select = useCallback(
    (key: WorkbenchBackdrop) => {
      if (locked) return;
      setDraft({ backdropKey: key, locked, failure: draft?.failure ?? null });
    },
    [locked, draft, setDraft],
  );

  const setLocked = useCallback(
    (next: boolean) =>
      setDraft({
        backdropKey,
        locked: next,
        failure: draft?.failure ?? null,
      }),
    [backdropKey, draft, setDraft],
  );

  const discardDraft = useCallback(() => setDraft(null), [setDraft]);

  const save = useCallback(() => {
    if (!dirty || busy) return;
    setBusy(true);
    api
      .saveWorkbenchBackground(pid, {
        backdrop_key: backdropKey,
        locked,
        expected_version: saved?.workbench_version ?? null,
      })
      .then(async () => {
        setDraft(null);
        await onChanged();
      })
      .catch((e) => {
        // Keep the pending values — the user decides whether to
        // overwrite or adopt the newer row; nothing auto-resends.
        setDraft({
          backdropKey,
          locked,
          failure:
            (e as { status?: number })?.status === 409
              ? "conflict"
              : "failed",
        });
        onErrorRef.current(e);
      })
      .finally(() => setBusy(false));
  }, [
    dirty,
    busy,
    pid,
    backdropKey,
    locked,
    saved,
    onChanged,
    setDraft,
  ]);

  return {
    backdropKey,
    locked,
    savedBackdropKey: savedKey,
    savedLocked,
    dirty,
    busy,
    saveFailure,
    select,
    setLocked,
    save,
    discardDraft,
  };
}
