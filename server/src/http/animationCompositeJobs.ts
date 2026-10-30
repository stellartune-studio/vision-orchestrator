import type { DatabaseSync } from "node:sqlite";
import { approvedAnimationInputs, renderAnimationBackground } from "../gen/animationBackground.ts";
import { compositeJobAssetIds, finishReconciledComposite, getCompositeJob, hasActiveCompositeJob, insertCompositeJob, listCompositeJobs, recordCompositeProcessEvidence, updateCompositeJob } from "../repos/animationCompositeJobs.ts";
import { assessProcesses, observeProcesses, type ProcessSnapshot } from "../gen/processIdentity.ts";
import { findAsset } from "../repos/assets.ts";
import { verifiedPromotionAsset } from "../gen/promotionAsset.ts";
import { BadRequestError, ConflictError } from "../repos/errors.ts";
import { Router, sendJson } from "./router.ts";

export function registerAnimationCompositeJobs(router: Router, db: DatabaseSync, storage: { assets_root: string; max_body_bytes: number; ffmpeg_bin?: string }, render = renderAnimationBackground, observe = observeProcesses): void {
  const owned = new Map<string, AbortController>();
  const view = (job: ReturnType<typeof getCompositeJob>) => {
    const { process_evidence: _evidence, ...publicJob } = job;
    return { ...publicJob, status: (job.status === "running" || job.status === "cancelling") && !owned.has(job.id) ? "unconfirmed" : job.status };
  };
  router.get("/api/projects/:id/animation-composite-jobs", (c) => sendJson(c.res, 200, listCompositeJobs(db, c.params.id).map(view)));
  router.get("/api/projects/:id/animation-composite-jobs/:jobId", (c) => sendJson(c.res, 200, view(getCompositeJob(db, c.params.id, c.params.jobId))));
  router.post("/api/projects/:id/animation-shots/:shotId/background-composite-jobs", (c) => {
    const body = c.body as Record<string, unknown> | null;
    if (typeof body?.blueprint_version_id !== "string") throw new BadRequestError("blueprint_version_id is required");
    const input = { projectId: c.params.id, shotId: c.params.shotId, blueprintId: body.blueprint_version_id, root: storage.assets_root, maxBytes: storage.max_body_bytes };
    approvedAnimationInputs(db, input);
    if (hasActiveCompositeJob(db, input.shotId)) throw new ConflictError("A composition for this shot is already active or unconfirmed");
    let job;
    try { job = insertCompositeJob(db, input.projectId, input.shotId, input.blueprintId); }
    catch (error) { if (hasActiveCompositeJob(db, input.shotId)) throw new ConflictError("A composition for this shot is already active or unconfirmed"); throw error; }
    const controller = new AbortController(); owned.set(job.id, controller);
    setImmediate(() => {
      void render(db, { ...input, ffmpeg: storage.ffmpeg_bin ?? "ffmpeg", signal: controller.signal, jobId: job.id, onProcessStart: (child) => {
        const pid = child.pid, observedAt = Date.now();
        if (!pid) return;
        void observe([process.pid, pid]).then((snapshot) => {
          if (!snapshot || !owned.has(job.id) || child.exitCode !== null || child.signalCode !== null) return;
          const parent = snapshot.processes.find((p) => p.pid === process.pid);
          const worker = snapshot.processes.find((p) => p.pid === pid);
          const start = worker ? Date.parse(worker.started) : NaN;
          // A short capture window and actual parent relationship prevent a reused PID being recorded as this spawn.
          if (!parent || !worker || worker.parent !== process.pid || Math.abs(start - observedAt) > 5000 || snapshot.processes.length !== 2 || assessProcesses(snapshot, snapshot) !== "active") return;
          recordCompositeProcessEvidence(db, input.projectId, job.id, JSON.stringify({ jobId: job.id, snapshot }));
        }).catch(() => { /* Missing evidence always leaves recovery unconfirmed. */ });
      } }).then((asset) => {
        updateCompositeJob(db, input.projectId, job.id, "succeeded", asset.id);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Composition failed";
        const cancelled = controller.signal.aborted && message === "Composition cancelled";
        updateCompositeJob(db, input.projectId, job.id, cancelled ? "cancelled" : "failed", null, message);
      }).finally(() => owned.delete(job.id)).catch(() => { owned.delete(job.id); });
    });
    sendJson(c.res, 202, view(job));
  });
  router.post("/api/projects/:id/animation-composite-jobs/:jobId/cancel", (c) => {
    const job = getCompositeJob(db, c.params.id, c.params.jobId);
    const controller = owned.get(job.id);
    if (!controller || (job.status !== "running" && job.status !== "cancelling")) throw new ConflictError("This composition is finished or its process ownership is unconfirmed");
    if (job.status === "running") updateCompositeJob(db, c.params.id, job.id, "cancelling");
    controller.abort();
    sendJson(c.res, 202, view(getCompositeJob(db, c.params.id, job.id)));
  });
  router.post("/api/projects/:id/animation-composite-jobs/:jobId/reconcile", async (c) => {
    const job = getCompositeJob(db, c.params.id, c.params.jobId);
    if (owned.has(job.id) || (job.status !== "running" && job.status !== "cancelling")) throw new ConflictError("Reconciliation is available only for an unconfirmed job");
    let original: ProcessSnapshot | null = null;
    try {
      const evidence = JSON.parse(job.process_evidence ?? "null") as { jobId?: unknown; snapshot?: ProcessSnapshot } | null;
      if (evidence?.jobId === job.id && evidence.snapshot?.processes?.length === 2 &&
          evidence.snapshot.processes.some((p) => evidence.snapshot!.processes.some((q) => q.pid !== p.pid && q.parent === p.pid))) original = evidence.snapshot;
    } catch { /* Legacy and malformed evidence cannot establish ownership. */ }
    let processState: "active" | "ended" | "unknown" = "unknown";
    if (original && assessProcesses(original, original) === "active") {
      try {
        const current = await observe(original.processes.map((p) => p.pid));
        processState = assessProcesses(original, current);
      } catch { /* A denied OS query cannot prove termination. */ }
    }
    if (owned.has(job.id)) throw new ConflictError("Composition ownership changed during reconciliation");
    const ids = compositeJobAssetIds(db, c.params.id, job.id);
    if (ids.length !== 1) {
      if (!ids.length && processState === "ended" && job.process_evidence && finishReconciledComposite(db, c.params.id, job.id, job.process_evidence, null)) {
        sendJson(c.res, 200, { status: "failed", process: processState, artifact: "not_found", safe_to_retry: true }); return;
      }
      sendJson(c.res, 200, { status: "recovery_needed", process: processState, artifact: ids.length ? "ambiguous" : "not_found", safe_to_retry: false }); return;
    }
    const asset = findAsset(db, ids[0]);
    try {
      if (!asset?.meta) throw new Error("missing provenance");
      const meta = JSON.parse(asset.meta) as { shot_id?: string; blueprint_version_id?: string; composition_job_id?: string };
      if (meta.shot_id !== job.shot_id || meta.blueprint_version_id !== job.blueprint_version_id || meta.composition_job_id !== job.id) throw new Error("provenance mismatch");
      verifiedPromotionAsset(asset, c.params.id, storage.assets_root, storage.max_body_bytes, "image/png");
      if (processState === "ended" && job.process_evidence && finishReconciledComposite(db, c.params.id, job.id, job.process_evidence, asset.id)) {
        sendJson(c.res, 200, { status: "succeeded", process: processState, artifact: "hash_verified", asset_id: asset.id, safe_to_retry: false }); return;
      }
      sendJson(c.res, 200, { status: "recovery_needed", process: processState, artifact: "hash_verified", asset_id: asset.id, safe_to_retry: false });
    } catch { sendJson(c.res, 200, { status: "recovery_needed", process: processState, artifact: "invalid", safe_to_retry: false }); }
  });
  router.onClose(() => { for (const controller of owned.values()) controller.abort(); });
}
