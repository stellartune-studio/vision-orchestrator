import { useCallback, useEffect, useRef, useState } from "react";
import type { ComparisonSelection } from "@vo/shared";
import { loadCompareSelection, saveCompareSelection } from "./compareSelection.ts";

type Draft = string[] | null;
type Session = { projectId: string; closed: boolean; loaded: boolean; busy: boolean; blocked: boolean; dirty: boolean; desired: Draft; version: number | null };
async function read(projectId: string): Promise<ComparisonSelection> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/comparison`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<ComparisonSelection>;
}
export function useComparison(projectId: string) {
  const [ids, setIds] = useState<Draft>(null);
  const [message, setMessage] = useState<"stale" | "conflict" | "unavailable" | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const session = useRef<Session | null>(null);
  useEffect(() => {
    const state: Session = { projectId, closed: false, loaded: false, busy: false, blocked: false, dirty: false, desired: null, version: null };
    session.current = state; setIds(null); setMessage(null);
    void read(projectId).then((saved) => {
      if (state.closed) return;
      state.version = saved.version;
      state.desired = saved.version === null ? loadCompareSelection(projectId) : saved.ids;
      state.loaded = true; setIds(state.desired);
      if (saved.stale) setMessage("stale");
    }).catch(() => { if (!state.closed) { state.blocked = true; setMessage("unavailable"); } });
    return () => { state.closed = true; };
  }, [projectId, loadKey]);
  const change = useCallback((update: (previous: Draft) => Draft) => {
    const state = session.current;
    if (!state || state.projectId !== projectId || state.closed || !state.loaded || state.blocked) return;
    state.desired = update(state.desired); state.dirty = true; setIds(state.desired);
    saveCompareSelection(projectId, state.desired);
    if (state.busy) return;
    state.busy = true;
    void (async () => {
      while (state.dirty && !state.closed && !state.blocked) {
        state.dirty = false;
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/comparison`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: state.desired, expected_version: state.version }) });
        if (state.closed) break;
        if (!response.ok) { state.blocked = true; setMessage(response.status === 409 ? "conflict" : "unavailable"); break; }
        const saved = await response.json() as ComparisonSelection;
        if (state.closed) break;
        state.version = saved.version; setMessage(saved.stale ? "stale" : null);
      }
    })().catch(() => { if (!state.closed) { state.blocked = true; setMessage("unavailable"); } }).finally(() => { state.busy = false; });
  }, [projectId]);
  return { ids, change, message, reload: () => setLoadKey((key) => key + 1) };
}
