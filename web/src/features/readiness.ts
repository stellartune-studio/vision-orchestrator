import { useEffect, useState } from "react";
import type {
  BlueprintVersion,
  BlueprintVersionDetail,
  ProjectState,
  ServerMeta,
  ItemKind,
} from "@vo/shared";
import { api } from "../api/client.ts";
import { KIND_LABEL } from "./labels.ts";

export type ReadinessTone = "ok" | "missing" | "info" | "pending";

export interface ReadinessItem {
  tone: ReadinessTone;
  label: string;
  detail?: string;
}

/**
 * Client-side mirror of the server production gate
 * (server/src/http/handlers.ts#checkProductionGate). All known
 * templates + the fallback require "intent" and "output_policy"
 * adopted inside the blueprint snapshot, plus an approved document
 * revision derived from that snapshot.
 *
 * This is an estimate for guidance only — the server's 422 response
 * remains authoritative.
 */
export const REQUIRED_KINDS = ["intent", "output_policy"] as const;

export type DetailStatus = "none" | "loading" | "ready" | "error";

/**
 * Fetch a blueprint version's detail once per id. Shared by the status
 * panel, the narrow next-step strip and the generation pane so all of
 * them agree on loading/error/ready instead of each guessing from a
 * bare null. `retry()` re-issues the fetch; a response for a superseded
 * id (project switch) is discarded via the cancellation flag.
 */
export function useBlueprintDetail(versionId: string | undefined): {
  status: DetailStatus;
  detail: BlueprintVersionDetail | null;
  retry: () => void;
} {
  const [status, setStatus] = useState<DetailStatus>(
    versionId ? "loading" : "none",
  );
  const [detail, setDetail] = useState<BlueprintVersionDetail | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!versionId) {
      setDetail(null);
      setStatus("none");
      return;
    }
    let cancelled = false;
    setDetail(null);
    setStatus("loading");
    api
      .blueprintVersion(versionId)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [versionId, tick]);

  return { status, detail, retry: () => setTick((t) => t + 1) };
}

/**
 * Map hook state onto buildReadiness' detail argument — the single place
 * where "loading" / "error" / "no version" are distinguished, so narrow
 * and wide guidance can never disagree.
 */
export function detailForReadiness(
  hasVersion: boolean,
  status: DetailStatus,
  detail: BlueprintVersionDetail | null,
): BlueprintVersionDetail | "error" | null | undefined {
  if (!hasVersion) return null;
  if (status === "loading") return undefined;
  if (status === "error") return "error";
  return detail;
}

export function buildReadiness(
  state: ProjectState,
  meta: ServerMeta | null,
  /** undefined = still loading; "error" = fetch failed; null = no version */
  detail: BlueprintVersionDetail | "error" | null | undefined,
  translate?: (key: string, values?: Record<string, string | number>) => string,
): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const latest: BlueprintVersion | undefined = state.blueprint_versions.at(-1);
  const kindLabel = (kind: ItemKind) => translate?.(`content.kind.${kind}`) ?? KIND_LABEL[kind];

  // 1. a frozen blueprint version exists
  items.push(
    latest
      ? {
          tone: "ok",
          label: translate?.("readiness.versionReady", { version: latest.version_no }) ?? `Blueprint version finalized (v${latest.version_no})`,
        }
      : {
          tone: "missing",
          label: translate?.("readiness.versionMissing") ?? "Blueprint version not finalized",
          detail: translate?.("readiness.versionMissingDetail") ?? "Finalize the current blueprint as a version to create a snapshot",
        },
  );

  if (latest) {
    // 2. required kinds adopted inside the snapshot
    if (detail === undefined) {
      items.push({
        tone: "pending",
        label: translate?.("readiness.blueprintLoading") ?? "Checking version contents…",
      });
    } else if (detail === "error") {
      items.push({
        tone: "missing",
        label: translate?.("readiness.blueprintUnavailable") ?? "Could not check version contents",
        detail: translate?.("readiness.blueprintUnavailableDetail") ?? "Load failed. Retry so readiness can be estimated",
      });
    } else if (detail) {
      const snapshotKinds = new Set(detail.items.map((i) => i.kind));
      const missingKinds = REQUIRED_KINDS.filter(
        (k) => !snapshotKinds.has(k),
      );
      items.push(
        missingKinds.length === 0
          ? {
              tone: "ok",
              label: translate?.("readiness.requiredPresent") ?? "Required items are adopted in the version",
              detail: REQUIRED_KINDS.map(kindLabel).join(", "),
            }
          : {
              tone: "missing",
              label: translate?.("readiness.requiredMissing", { kinds: missingKinds.map(kindLabel).join(", ") }) ?? `Required items not yet adopted in the version: ${missingKinds.map((k) => KIND_LABEL[k]).join(", ")}`,
              detail: translate?.("readiness.requiredMissingDetail") ?? "Adopt the items, then recreate the version (later adoptions are not reflected)",
            },
      );
    }

    // 3. an approved document revision derived from THIS version
    const approvedFromVersion = state.documents.some(
      (d) =>
        d.adopted_revision &&
        d.adopted_revision.blueprint_version_id === latest.id,
    );
    items.push(
      approvedFromVersion
        ? { tone: "ok", label: translate?.("readiness.approvedDocPresent") ?? "An approved document exists from this version" }
        : {
            tone: "missing",
            label: translate?.("readiness.approvedDocMissing") ?? "Documents from this version are not approved yet",
            detail: translate?.("readiness.approvedDocMissingDetail") ?? "Create a script or storyboard under Documents and approve it",
          },
    );
  }

  // 4. backend capability / honesty about mock vs real
  if (meta) {
    items.push(
      meta.gen_backend === "mock"
        ? {
            tone: "info",
            label: translate?.("readiness.backendMock") ?? "Generation backend: verification mock",
            detail: translate?.("readiness.backendMockDetail") ?? "Not real generation (for appearance checks only)",
          }
        : {
            tone: "info",
            label: translate?.("readiness.backend", { backend: meta.gen_backend }) ?? `Generation backend: ${meta.gen_backend}`,
            detail: meta.gen_kinds.includes("video")
              ? translate?.("readiness.imageVideoSupported") ?? "Image and video supported"
              : translate?.("readiness.imageOnlySupported") ?? "Image only",
          },
    );
    if (!meta.gen_kinds.includes("video")) {
      items.push({
        tone: "info",
        label: translate?.("readiness.videoUnsupported") ?? "Video generation: unsupported on the current backend",
      });
    }
  }

  return items;
}

/**
 * Client-side mirror of the server's snapshot fingerprint
 * (server/src/repos/blueprints.ts#snapshotSignature). True when the
 * project's live blueprint — adopted item revisions, their order and
 * parent links, pinned character revisions, selected assets — has
 * drifted from the given frozen version. The generation preview uses
 * it to say "this snapshot" vs "current edits" honestly instead of
 * showing live state as what will be generated from.
 */
export function blueprintDrifted(
  detail: BlueprintVersionDetail,
  state: ProjectState,
): boolean {
  const curItems = new Map(
    state.items
      .filter((i) => i.adopted_revision_id !== null)
      .map((i) => [i.id, i] as const),
  );
  if (detail.items.length !== curItems.size) return true;
  for (const i of detail.items) {
    const cur = curItems.get(i.item_id);
    if (
      !cur ||
      cur.adopted_revision_id !== i.revision_id ||
      cur.seq !== i.seq ||
      (cur.parent_item_id ?? null) !== (i.parent_item_id ?? null)
    ) {
      return true;
    }
  }
  const curChars = new Map(
    state.characters.map((pc) => [
      pc.character_id,
      pc.character_revision_id,
    ]),
  );
  if (detail.characters.length !== curChars.size) return true;
  for (const c of detail.characters) {
    if (curChars.get(c.character_id) !== c.character_revision_id) {
      return true;
    }
  }
  const curAssets = new Set(
    state.assets.filter((a) => a.selected === 1).map((a) => a.id),
  );
  if (detail.assets.length !== curAssets.size) return true;
  for (const a of detail.assets) {
    if (!curAssets.has(a.asset_id)) return true;
  }
  return false;
}

export function readinessReady(items: ReadinessItem[]): boolean {
  // pending (detail still loading) never counts as ready either —
  // "前提条件が揃っています" may only claim verified state.
  return items.every((i) => i.tone === "ok" || i.tone === "info");
}
