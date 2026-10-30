import { blueprintDriftNotes, getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { findItemRevision, getItem } from "../repos/items.ts";
import { listProjectCharacters } from "../repos/characters.ts";
import { sceneCharacters } from "../repos/sceneCharacters.ts";
import { sceneEditSource } from "../repos/sceneEditSources.ts";
import { verifySceneEditSource } from "../gen/sceneEditSource.ts";
import { findDocumentRevision } from "../repos/documents.ts";
import { GenerationRejectedError, JobNotFoundError } from "../gen/backend.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { GenerationRecord, QwenReferenceSize } from "@vo/shared";
import { transact } from "../db/connection.ts";
import type { GenerationBackend, GenerationInput } from "../gen/backend.ts";
import { buildGenerationInput } from "../gen/inputBuilder.ts";
import { findAsset, getAsset, insertAsset } from "../repos/assets.ts";
import { BadRequestError, UnprocessableError } from "../repos/errors.ts";
import {
  getGeneration,
  insertGeneration,
  updateGenerationStatus,
  hasActiveGenerations,
  activeGenerationIds,
  generationDedupCandidates,
} from "../repos/generations.ts";
import { isUnder } from "../util/paths.ts";
import { mimeForPath } from "../util/media.ts";
import { Router, sendJson } from "./router.ts";
import type { ServerConfig } from "../config.ts";
import { getGenerationSelection } from "../repos/generationSelection.ts";
import { ConflictError } from "../repos/errors.ts";
import { readLocalJson } from "../environment/executeExisting.ts";
import { workflowCatalogIssues } from "../gen/catalogValidation.ts";
import { withGenerationRequest, hasGenerationRequests } from "../gen/activity.ts";
import { qwenReferenceCanvas, qwenResolutionForArea } from "../gen/qwenResolution.ts";
import { probeImageDimensions } from "../gen/imageDimensions.ts";
import { getComparison, saveComparison } from "../repos/comparison.ts";

export interface GenerationGateResult {
  ok: boolean;
  missing: string[];
  document_revision_ids: string[];
}

export type ProductionGateCheck = (
  db: DatabaseSync,
  projectId: string,
  blueprintVersionId: string,
) => GenerationGateResult;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

export interface GenerationRouteDeps {
  db: DatabaseSync;
  config: ServerConfig;
  gen: GenerationBackend;
  checkProductionGate: ProductionGateCheck;
  /** Test seam for deterministic local media metadata. */
  probeDimensions?: typeof probeImageDimensions;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function registerGenerationRoutes(
  r: Router,
  deps: GenerationRouteDeps,
): void {
  const { db, config, gen, checkProductionGate } = deps;
  r.get("/api/projects/:id/comparison", (context) => sendJson(context.res, 200, getComparison(db, context.params.id, config.assets_root)));
  r.put("/api/projects/:id/comparison", (context) => {
    const body = context.body as Record<string, unknown> | null;
    if (!body || !Object.hasOwn(body, "ids") || !Object.hasOwn(body, "expected_version")) throw new BadRequestError("ids and expected_version are required");
    sendJson(context.res, 200, transact(db, () => saveComparison(db, context.params.id, body.ids, body.expected_version, config.assets_root)));
  });
  const probeDimensions = deps.probeDimensions ?? probeImageDimensions;
  function confirmedScene(projectId: string, blueprintId: string, sceneId: string): void {
    const blueprint = getBlueprintVersionDetail(db, blueprintId);
    if (blueprintDriftNotes(db, blueprintId).length) throw new ConflictError("Approved blueprint changed; freeze a new blueprint and approve its script");
    const frozen = blueprint.items.find((item) => item.item_id === sceneId && item.kind === "story_segment");
    if (blueprint.project_id !== projectId || !frozen) throw new UnprocessableError("Scene is not in this project's approved blueprint");
    const current = getItem(db, sceneId);
    if (current.adopted_revision_id !== frozen.revision_id) throw new ConflictError("Scene approval changed; freeze a new blueprint and approve its script");
    const pins = listProjectCharacters(db, projectId);
    if (sceneCharacters(db, frozen.revision_id).some((cast) => !pins.some((pin) => pin.character_id === cast.character_id && pin.character_revision_id === cast.character_revision_id))) throw new ConflictError("Scene character pin changed; update and approve the scene and blueprint");
  }
  const releaseEnabled = process.env.VO_AUTO_RELEASE_LOCAL_REFERENCES !== "false";
  const intervalValue = Number(process.env.VO_GENERATION_MONITOR_MS ?? 5000);
  const monitorInterval = Number.isInteger(intervalValue) && intervalValue >= 1000 && intervalValue <= 60000 ? intervalValue : 5000;
  let monitoring = false;
  let localReferencesDropped = false;

  function releaseLocalWhenIdle(): void {
    // Defer until a submit's withGenerationRequest has left its finally.
    setImmediate(() => {
      try {
        if (releaseEnabled && !hasGenerationRequests(gen) && !hasActiveGenerations(db) && gen.releaseLocalReferences) {
          gen.releaseLocalReferences();
          localReferencesDropped = true;
        }
      } catch {
        // A closed database or unknown state must not cause remote cleanup.
      }
    });
  }

  r.get("/api/environment/memory-status", (c) => sendJson(c.res, 200, {
    local_reference_release: !releaseEnabled ? "disabled" : hasGenerationRequests(gen) || hasActiveGenerations(db) ? "waiting" : localReferencesDropped ? "reference_dropped" : "pending",
    gpu_release: "unsupported",
    gpu_release_reason: "ComfyUI server ownership and exclusive access cannot be verified",
    monitor_interval_ms: monitorInterval,
  }));

  // Poll independently of browser clients. Unconfirmed jobs stay active; the
  // existing poll path reconciles them without submitting a new job.
  const timer = setInterval(() => {
    if (monitoring) return;
    monitoring = true;
    void (async () => {
      try {
        for (const id of activeGenerationIds(db, gen.name)) {
          try {
            const record = getGeneration(db, id);
            if (!gen.isMock) {
              const origin = JSON.parse(record.inputs).resolved_refs?.backend?.connection_origin;
              if (typeof origin !== "string" || origin !== gen.describe?.().connection_origin) continue;
            }
            await pollOnce(id);
          } catch { /* retain the record for reconciliation */ }
        }
        releaseLocalWhenIdle();
      } catch { /* database may be closed; no remote release */ }
      finally { monitoring = false; }
    })();
  }, monitorInterval);
  timer.unref();
  r.onClose(() => clearInterval(timer));

  async function referenceSize(input: GenerationInput): Promise<QwenReferenceSize> {
    const assetId = input.resolved_refs.ref_image_asset_ids[0];
    if (input.ref_images.length !== 1 || !assetId) throw new UnprocessableError("Qwen reference preflight requires exactly one pinned image");
    try {
      const dimensions = await probeDimensions(input.ref_images[0], config.assets_root, config.max_body_bytes);
      const sourceHash = await hashFile(input.ref_images[0]);
      const asset = findAsset(db, assetId);
      if (!asset?.sha256 || asset.sha256.toLowerCase() !== sourceHash.toLowerCase()) throw new Error("Reference image content differs from its recorded hash");
      const resolution = qwenResolutionForArea(input.settings.width, input.settings.height);
      const canvas = qwenReferenceCanvas(dimensions.width, dimensions.height, resolution);
      return { asset_id: assetId, source_sha256: sourceHash, source_width: dimensions.width, source_height: dimensions.height, requested_width: input.settings.width ?? null, requested_height: input.settings.height ?? null, resolution, ...canvas };
    } catch (error) {
      throw new UnprocessableError(`Reference size preflight unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  r.post("/api/projects/:id/qwen-reference-size", async (c) => {
    const body = (c.body ?? {}) as Record<string, unknown>;
    const blueprintId = str(body.blueprint_version_id);
    if (!blueprintId) throw new BadRequestError("blueprint_version_id is required");
    const sceneId = str(body.story_scene_id);
    if (body.story_scene_id !== undefined && !sceneId) throw new BadRequestError("story_scene_id must be a non-empty string");
    if (sceneId) confirmedScene(c.params.id, blueprintId, sceneId);
    const saved = getGenerationSelection(db, c.params.id);
    if (gen.isMock || saved.selection || config.gen_profile !== "qwen-image-2.1-turbo") throw new UnprocessableError("Reference size preflight requires the bundled Qwen image workflow");
    const input = buildGenerationInput(db, { project_id: c.params.id, blueprint_version_id: blueprintId, backend: gen, kind: "image", story_scene_id: sceneId });
    sendJson(c.res, 200, await referenceSize(input));
  });

  r.post("/api/projects/:id/generations", (c) => withGenerationRequest(gen, async () => {
    localReferencesDropped = false;
    const b = (c.body ?? {}) as Record<string, unknown>;
    const blueprint_version_id = str(b.blueprint_version_id);
    const kind = str(b.kind) ?? "image";
    const storySceneId = str(b.story_scene_id);
    if (b.story_scene_id !== undefined && !storySceneId) throw new BadRequestError("story_scene_id must be a non-empty string");
    if (storySceneId && (kind !== "image" || !blueprint_version_id)) throw new BadRequestError("Storyboard scene generation requires an image and blueprint version");
    if (storySceneId && blueprint_version_id) confirmedScene(c.params.id, blueprint_version_id, storySceneId);
    const savedSelection = getGenerationSelection(db, c.params.id);
    if (storySceneId && savedSelection.selection?.prompt_verbatim) throw new UnprocessableError("Verbatim workflows cannot apply a selected scene");
    if (savedSelection.version > 0 && b.selection_version !== savedSelection.version) {
      throw new ConflictError("Confirm the current workflow selection before generating");
    }
    const qwenEdit = !savedSelection.selection && config.gen_profile === "qwen-image-2.1-turbo-edit-single";
    let editSource: ReturnType<typeof findAsset>;
    let editSourcePath: string | undefined;
    let editSourceSha256: string | undefined;
    let qwenSeed = 891836227295375;
    if (qwenEdit) {
      const allowed = new Set([
        "blueprint_version_id",
        "kind",
        "document_revision_id",
        "edit_source_asset_id",
        "seed",
        "selection_version",
        "story_scene_id",
      ]);
      const unsupported = Object.keys(b).filter((key) => !allowed.has(key));
      if (unsupported.length) {
        throw new BadRequestError(
          `Qwen single-image edit does not support: ${unsupported.join(", ")}`,
        );
      }
      if (kind !== "image") {
        throw new UnprocessableError(
          "Qwen profile supports image editing only",
        );
      }
      const sourceId = str(b.edit_source_asset_id);
      if (!sourceId)
        throw new BadRequestError(
          "edit_source_asset_id is required for Qwen image editing",
        );
      editSource = findAsset(db, sourceId);
      if (storySceneId && blueprint_version_id) {
        const blueprint = getBlueprintVersionDetail(db, blueprint_version_id);
        const frozen = blueprint.items.find((item) => item.item_id === storySceneId)!;
        const approved = sceneEditSource(db, frozen.revision_id);
        if (!approved || approved.asset_id !== sourceId) throw new ConflictError("Adopt this scene's edit source and freeze a new blueprint before generating");
        const checked = verifySceneEditSource(db, { projectId: c.params.id, sceneRevisionId: frozen.revision_id, assetId: sourceId, root: config.assets_root, maxBytes: config.max_body_bytes });
        if (checked.asset.sha256?.toLowerCase() !== approved.sha256.toLowerCase()) throw new ConflictError("Approved scene edit source changed");
        if (!blueprint.assets.some((asset) => asset.asset_id === sourceId) && !blueprint.characters.some((character) => character.base_image_asset_id === sourceId && sceneCharacters(db, frozen.revision_id).some((cast) => cast.character_id === character.character_id && cast.character_revision_id === character.character_revision_id))) throw new ConflictError("Approved edit source is not frozen in this blueprint");
        editSource = checked.asset;
      } else if (
        !editSource ||
        editSource.owner_kind !== "project" ||
        editSource.owner_id !== c.params.id
      ) {
        throw new UnprocessableError(
          "edit source must be an asset owned by this project",
        );
      }
      if (!editSource.mime?.startsWith("image/")) {
        throw new UnprocessableError("edit source must be an image asset");
      }
      try {
        const candidate = realpathSync(editSource.path);
        const assetsRoot = realpathSync(config.assets_root);
        if (!isUnder(assetsRoot, candidate) || !statSync(candidate).isFile()) {
          throw new Error("outside project asset storage");
        }
        editSourcePath = candidate;
      } catch {
        throw new UnprocessableError(
          "edit source file is missing or outside project asset storage",
        );
      }
      if (b.seed !== undefined) {
        if (
          typeof b.seed !== "number" ||
          !Number.isSafeInteger(b.seed) ||
          b.seed < 0
        ) {
          throw new BadRequestError("seed must be a non-negative safe integer");
        }
        qwenSeed = b.seed;
      }
      editSourceSha256 = await hashFile(editSourcePath);
      if (
        editSource.sha256 &&
        editSource.sha256.toLowerCase() !== editSourceSha256
      ) {
        throw new UnprocessableError(
          "edit source content no longer matches its registered asset hash",
        );
      }
    } else if (b.edit_source_asset_id !== undefined) {
      throw new BadRequestError(
        "edit_source_asset_id requires the Qwen edit profile",
      );
    }
    if (!blueprint_version_id) {
      throw new BadRequestError("blueprint_version_id is required");
    }
    if (kind !== "image" && kind !== "video") {
      throw new BadRequestError('kind must be "image" or "video"');
    }
    if (!gen.capabilities.kinds.includes(kind)) {
      throw new UnprocessableError(
        `backend "${gen.name}" does not support kind "${kind}"`,
      );
    }
    const projectId = c.params.id;

    // Production gate — verified server-side, not just by UI buttons.
    const gate = checkProductionGate(db, projectId, blueprint_version_id);
    if (!gate.ok) {
      throw new UnprocessableError(
        `production requirements not met: ${gate.missing.join("; ")}`,
      );
    }
    // The document basis recorded for traceability is an approved
    // revision that satisfied the gate — resolved server-side so the
    // client cannot claim a different document than the gate checked.
    // Omitted: resolvable only when the candidate is unambiguous —
    // several approved documents require an explicit choice.
    const explicitDocRev = str(b.document_revision_id);
    let document_revision_id: string;
    if (explicitDocRev) {
      const row = db
        .prepare(
          `SELECT 1 FROM production_documents d
             JOIN document_revisions dr ON dr.id = d.adopted_revision_id
            WHERE d.project_id = ? AND dr.id = ?
              AND dr.blueprint_version_id = ?`,
        )
        .get(projectId, explicitDocRev, blueprint_version_id);
      if (!row) {
        throw new UnprocessableError(
          "document_revision_id must be this project's adopted revision derived from this blueprint version",
        );
      }
      document_revision_id = explicitDocRev;
    } else if (gate.document_revision_ids.length === 1) {
      document_revision_id = gate.document_revision_ids[0];
    } else {
      throw new UnprocessableError(
        `${gate.document_revision_ids.length} approved documents derive ` +
          "from this blueprint version — specify document_revision_id",
      );
    }
    const duration_seconds =
      typeof b.duration_seconds === "number" &&
      Number.isFinite(b.duration_seconds)
        ? b.duration_seconds
        : undefined;

    const input = buildGenerationInput(db, {
      project_id: projectId,
      blueprint_version_id,
      document_revision_id,
      backend: gen,
      kind,
      story_scene_id: storySceneId,
      exclusive_edit_source_id: storySceneId && qwenEdit ? str(b.edit_source_asset_id) : undefined,
      native_video_size: kind === "video" && !savedSelection.selection,
      // camera_work injects only into the verified H3 prompt path:
      // a selected workflow whose graph deep-equals the bundled fasth3
      // graph. The Wan2.2 default (no selection) and any other video
      // workflow leave the prompt untouched.
      camera_prompt: isVerifiedCameraPath(kind, savedSelection.selection),
      duration_seconds,
    });
    if (!gen.isMock && !savedSelection.selection && !qwenEdit && kind === "image" && input.ref_images.length > 0) {
      const candidate = await referenceSize(input);
      if (!isDeepStrictEqual(b.reference_size, candidate)) throw new UnprocessableError("Confirm the current Qwen reference size before generation; reload if the reference changed");
      input.settings.width = candidate.width;
      input.settings.height = candidate.height;
      input.settings.qwen_reference_resolution = candidate.resolution;
      input.settings.qwen_reference_size = candidate;
    }
    // The builder randomizes the seed so re-issues explore variations.
    // Such a seed is a sample parameter, not request identity: two
    // requests that differ only by it still deduplicate. An explicit
    // (user or profile) seed replaces this value and stays part of the
    // request identity.
    const builderSeed = input.settings.seed;
    if (!qwenEdit && b.seed !== undefined) {
      if (
        typeof b.seed !== "number" ||
        !Number.isSafeInteger(b.seed) ||
        b.seed < 0
      ) {
        throw new BadRequestError("seed must be a non-negative safe integer");
      }
      input.settings.seed = b.seed;
    }
    if (input.resolved_refs.camera_work_revision_ids?.length) {
      // adopted vs applied stay distinct; the hash identifies which
      // graph content the camera direction was verified against
      input.resolved_refs.camera_work_verified_graph_sha256 =
        input.resolved_refs.camera_work_applied_revision_ids?.length
          ? bundledFasth3().sha256
          : undefined;
    }
    if (savedSelection.selection) {
      if (savedSelection.selection.kind !== kind) throw new UnprocessableError("Selected workflow kind does not match request");
      if (input.ref_images.length && !savedSelection.selection.reference) throw new UnprocessableError("Selected workflow has no reference binding");
      // Reject settings that a generic graph cannot silently reinterpret.
      for (const key of ["width", "height", "duration_seconds"] as const) {
        if (input.settings[key] != null && !savedSelection.selection.settings?.[key]) {
          throw new UnprocessableError(`Selected workflow needs an explicit ${key} binding for the approved output policy`);
        }
      }
      if (savedSelection.selection.prompt_verbatim) {
        const document = findDocumentRevision(db, document_revision_id);
        const original = savedSelection.selection.graph[savedSelection.selection.prompt.node].inputs[savedSelection.selection.prompt.input];
        if (!document || document.content !== original) throw new UnprocessableError("Verbatim reproduction requires the approved document to exactly match the workflow prompt literal");
        if (input.ref_images.length || input.resolved_refs.asset_ids.length || input.resolved_refs.character_revision_ids.length) throw new UnprocessableError("Verbatim reproduction cannot silently omit pinned assets or characters");
        const frozen = getBlueprintVersionDetail(db, blueprint_version_id);
        for (const item of frozen.items) {
          if (item.kind === "purpose" || item.kind === "output_policy" || item.kind === "camera_work") continue;
          const revision = findItemRevision(db, item.revision_id);
          if (!revision || !document.content.includes(revision.content)) throw new UnprocessableError("Verbatim reproduction document must contain all approved blueprint content; additional constraints cannot be silently omitted");
        }
        input.prompt = document.content;
      }
      input.settings.workflow_selection = savedSelection.selection;
      delete input.settings.seed; // Preserve the graph literal/explicit selection; never inject builder seed=42.
      if (!gen.isMock) {
        const catalog = await readLocalJson((process.env.COMFY_DISCOVERY_URL ?? "http://127.0.0.1:8288") + "/object_info");
        const issues = workflowCatalogIssues(savedSelection.selection, catalog, input.settings, input.ref_images.length > 0);
        if (issues.length) throw new UnprocessableError(`Workflow catalog mismatch: ${issues.join("; ")}`);
      }
    }
    if (qwenEdit && editSource && editSourcePath && editSourceSha256) {
      const pinnedRefs = input.resolved_refs.ref_image_asset_ids;
      if (pinnedRefs.some((id) => id !== editSource!.id)) {
        throw new UnprocessableError(
          "Qwen accepts one explicitly selected edit source; other pinned character/material images must be removed from this blueprint",
        );
      }
      if (input.settings.width != null || input.settings.height != null) {
        throw new UnprocessableError(
          "this Qwen profile uses source-driven resolution and cannot apply output width/height settings",
        );
      }
      input.ref_images = [editSourcePath];
      input.settings.seed = qwenSeed;
      input.resolved_refs.edit_source_asset_id = editSource.id;
      input.resolved_refs.edit_source_sha256 = editSourceSha256;
      if (!input.resolved_refs.asset_ids.includes(editSource.id)) {
        input.resolved_refs.asset_ids.push(editSource.id);
      }
      if (!input.resolved_refs.used_asset_ids.includes(editSource.id)) {
        input.resolved_refs.used_asset_ids.push(editSource.id);
      }
      input.resolved_refs.ref_image_asset_ids = [editSource.id];
    }
    input.resolved_refs.backend = gen.describe?.(input) ?? {};
    const inputsJson = JSON.stringify(input);
    // Dedup identity: when the seed was builder-randomized it is
    // stripped from the comparison; an explicitly chosen seed keeps
    // exact-match semantics.
    const seedVolatile =
      input.settings.seed !== undefined &&
      input.settings.seed === builderSeed;
    const dedupJson = seedVolatile
      ? JSON.stringify({ ...input, settings: { ...input.settings, seed: undefined } })
      : inputsJson;
    const stripVolatileSeed = (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as GenerationInput;
        if (parsed.settings) parsed.settings.seed = undefined;
        return JSON.stringify(parsed);
      } catch {
        return raw;
      }
    };

    // Match-or-insert inside one IMMEDIATE transaction: concurrent
    // POSTs serialize on the write lock, so the same input snapshot
    // produces exactly one record. The snapshot carries settings
    // (seed, duration) and resolved refs — a changed input is a
    // distinct generation and never merges into an existing job.
    const { record, reused } = transact(db, () => {
      if (storySceneId) {
        confirmedScene(projectId, blueprint_version_id, storySceneId);
        const currentGate = checkProductionGate(db, projectId, blueprint_version_id);
        if (!currentGate.ok || !currentGate.document_revision_ids.includes(document_revision_id)) throw new ConflictError("Approved document changed; review the blueprint and script again");
      }
      const dup = generationDedupCandidates(db, projectId).find((row) =>
        (row.status !== "succeeded" || !!storySceneId) && (seedVolatile ? stripVolatileSeed(row.inputs) === dedupJson : row.inputs === dedupJson),
      );
      if (dup) {
        return { record: getGeneration(db, dup.id), reused: true };
      }
      return {
        record: insertGeneration(db, {
          project_id: projectId,
          kind,
          blueprint_version_id,
          document_revision_id,
          inputs: inputsJson,
          backend: gen.name,
        }),
        reused: false,
      };
    });
    if (reused) {
      await pollOnce(record.id);
      sendJson(c.res, 200, getGeneration(db, record.id));
      return;
    }

    // Backend submit — outside any DB transaction.
    try {
      const job = await gen.submit(input, {
        project_id: projectId,
        generation_id: record.id,
      });
      const running = transact(db, () =>
        updateGenerationStatus(db, {
          id: record.id,
          status: "running",
          backend_job_id: job.backend_job_id,
        }),
      );
      // One immediate poll (mock completes synchronously; real jobs
      // keep "running" and are polled via GET /api/generations/:id).
      await pollOnce(running.id);
      sendJson(c.res, 200, getGeneration(db, running.id));
    } catch (err) {
      transact(db, () => {
        const current = getGeneration(db, record.id);
        if (current.status !== "queued" && current.status !== "running") return;
        updateGenerationStatus(db, {
          id: record.id,
          status: err instanceof GenerationRejectedError && !current.backend_job_id ? "failed" : current.status,
          error: err instanceof GenerationRejectedError ? err.message : `Outcome unconfirmed; reconcile this generation, do not submit a new one: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
      sendJson(c.res, 200, getGeneration(db, record.id));
    }
  }).finally(releaseLocalWhenIdle));

  r.post("/api/generations/:id/cancel", async (c) => {
    const rec = getGeneration(db, c.params.id);
    if (rec.status !== "queued" && rec.status !== "running") throw new ConflictError("Generation is already terminal");
    if (!rec.backend_job_id || !gen.cancel) throw new ConflictError("Cancellation is unavailable until the remote job is identified");
    let recordedOrigin: unknown;
    try { recordedOrigin = JSON.parse(rec.inputs).resolved_refs?.backend?.connection_origin; } catch { /* no origin to verify */ }
    const currentOrigin = gen.describe?.().connection_origin;
    if (typeof recordedOrigin !== "string" || typeof currentOrigin !== "string" || recordedOrigin !== currentOrigin) {
      throw new ConflictError("Restore the generation's recorded environment before cancellation");
    }
    await gen.cancel({ backend_job_id: rec.backend_job_id });
    // Cancellation is a request, not confirmation. Polling owns terminal state.
    sendJson(c.res, 202, { requested: true });
  });

  r.get("/api/generations/:id", async (c) => {
    try {
      await pollOnce(c.params.id);
      sendJson(c.res, 200, getGeneration(db, c.params.id));
    } finally {
      releaseLocalWhenIdle();
    }
  });

  async function pollOnce(genId: string): Promise<void> {
    const rec = getGeneration(db, genId);
    if (rec.status !== "running" && rec.status !== "queued") return;
    let recordedOrigin: unknown;
    try { recordedOrigin = JSON.parse(rec.inputs).resolved_refs?.backend?.connection_origin; } catch { /* handled by existing reconciliation validation */ }
    const currentOrigin = gen.describe?.().connection_origin;
    if (typeof recordedOrigin === "string" && typeof currentOrigin === "string" && recordedOrigin !== currentOrigin) {
      throw new ConflictError("Generation belongs to another environment; restore its recorded connection before polling. Job state was preserved.");
    }
    let backendJobId = rec.backend_job_id;
    if (!backendJobId) {
      // Missing response is not proof of non-acceptance. Lookup only: a new
      // submit is never issued automatically, even with the same key.
      try {
        const found = await gen.findJob?.({ project_id: rec.project_id, generation_id: rec.id });
        if (found?.backend_job_id) {
          transact(db, () => updateGenerationStatus(db, { id: rec.id, status: "running", backend_job_id: found.backend_job_id, error: null }));
          backendJobId = found.backend_job_id;
        }
      } catch { /* preserve the queued record and its correlation while lookup is unavailable */ }
      if (!backendJobId) return;
    }
    // The output node was snapshotted into inputs.resolved_refs.backend
    // at submit time — a rehydrated poll uses exactly that node.
    let outputNode: string | undefined;
    try {
      const snap = JSON.parse(rec.inputs) as {
        resolved_refs?: { backend?: { output_node?: string } };
      };
      outputNode = snap.resolved_refs?.backend?.output_node;
    } catch {
      /* keep undefined — backend falls back to its base spec */
    }
    let result;
    try { result = await gen.poll(
      { backend_job_id: backendJobId },
      {
        project_id: rec.project_id,
        generation_id: rec.id,
        output_node: outputNode,
      },
    );
    } catch (error) {
      transact(db, () => {
        const current = getGeneration(db, rec.id);
        if (current.status === "queued" || current.status === "running") {
          // Job-absent is a definitive lookup, not a transport failure:
          // the record is preserved for manual reconciliation and never
          // auto-resubmitted — the message distinguishes the two cases.
          const note = error instanceof JobNotFoundError
            ? `Remote job not found; reconciliation required, no automatic resubmit: ${error.message}`
            : `Poll unavailable; same job retained: ${error instanceof Error ? error.message : String(error)}`;
          updateGenerationStatus(db, { id: rec.id, status: current.status, error: note });
        }
      });
      return;
    }
    if (result.status === "running") {
      // A successful poll confirms transport recovery even when the job
      // has no output yet. Clear the stale warning without advancing or
      // reopening a record completed by a concurrent poll.
      if (rec.error) transact(db, () => {
        const current = getGeneration(db, rec.id);
        if (current.status !== "queued" && current.status !== "running") return;
        updateGenerationStatus(db, { id: rec.id, status: current.status, error: null });
      });
      return;
    }
    if (result.status === "succeeded" && result.output_files?.length) {
      let expected: QwenReferenceSize | undefined;
      try { expected = (JSON.parse(rec.inputs) as { settings?: { qwen_reference_size?: QwenReferenceSize } }).settings?.qwen_reference_size; } catch { /* historical records retain their existing behavior */ }
      if (expected) {
        try {
          const measured = await probeDimensions(result.output_files[0], config.assets_root, config.max_body_bytes);
          if (measured.width !== expected.width || measured.height !== expected.height) {
            result = { status: "failed", error: `Qwen output dimensions differ from confirmed size: expected ${expected.width}×${expected.height}, received ${measured.width}×${measured.height}`, output_files: result.output_files };
          }
        } catch {
          result = { status: "failed", error: "Qwen output dimensions could not be verified; the output was not accepted", output_files: result.output_files };
        }
      }
    }
    // Hash the adopted output outside the transaction so the recorded
    // asset carries the same provenance hash as user uploads.
    let adoptedHash: string | undefined;
    let adoptedMeta: string | undefined;
    if (result.status === "succeeded" && result.output_files?.length) {
      try {
        adoptedHash = await hashFile(result.output_files[0]);
      } catch (e) {
        // Record that this asset's sha256 was NOT verified, why, and
        // that a later re-hash of the file is still possible — keep it
        // distinct from hash-verified assets.
        const msg = e instanceof Error ? e.message : String(e);
        // Only a recognizably transient FS failure is marked retryable.
        // EPERM can be a permanent permission denial and unknown causes
        // stay "unconfirmed" — retryability is never assumed.
        adoptedMeta = JSON.stringify({
          sha256_status: "unverified",
          sha256_error: msg,
          sha256_retryable: /EBUSY|EMFILE|EAGAIN/i.test(msg)
            ? true
            : "unconfirmed",
        });
      }
    }
    try {
      transact(db, () => {
        // Re-read under the write lock: a concurrent poll may already
        // have committed the outcome — never double-register outputs.
        const cur = getGeneration(db, rec.id);
        if (cur.status !== "running" && cur.status !== "queued") {
          // This attempt lost: drop its staged downloads, but never
          // the file the winning attempt registered.
          dropStagedOutputs(db, cur, result.output_files);
          return;
        }
        if (result.status === "succeeded" && result.output_files?.length) {
          const [file, ...rest] = result.output_files;
          const asset = insertAsset(db, {
            owner_kind: "project",
            owner_id: rec.project_id,
            kind: "generated",
            path: file,
            mime: mimeForPath(file),
            sha256: adoptedHash,
            meta: adoptedMeta,
          });
          const done = updateGenerationStatus(db, {
            id: rec.id,
            status: "succeeded", error: null,
            output_asset_id: asset.id,
          });
          // This attempt adopted only output_files[0]; extra downloads
          // belong to this attempt and are removed (never the adopted
          // file, even if a backend reported duplicate paths).
          dropStagedOutputs(db, done, rest);
        } else {
          const done = updateGenerationStatus(db, {
            id: rec.id,
            status: "failed",
            error: result.error ?? "unknown backend error",
          });
          // A failed result can still carry files this attempt staged
          // — they are this attempt's property and are removed.
          dropStagedOutputs(db, done, result.output_files);
        }
      });
    } catch (err) {
      markPollFailed(db, rec.id, result.output_files, err);
    }
  }
}

/** Path of the output asset this record adopted, if one exists. */
function registeredOutputPath(
  db: DatabaseSync,
  rec: GenerationRecord,
): string | null {
  if (!rec.output_asset_id) return null;
  try {
    return getAsset(db, rec.output_asset_id).path;
  } catch {
    /* asset row missing — nothing is adopted */
    return null;
  }
}

/**
 * Remove a poll attempt's staged downloads, except the file the record
 * already adopted. Ownership boundary: cleanup only ever touches the
 * files THIS attempt staged (its result.output_files), and never the
 * registered output committed by another attempt.
 */
function dropStagedOutputs(
  db: DatabaseSync,
  rec: GenerationRecord,
  staged: string[] | undefined,
): void {
  const keep = registeredOutputPath(db, rec);
  for (const f of staged ?? []) {
    if (f !== keep) {
      try {
        unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Recovery when the outcome commit failed: drop this attempt's staged
 * outputs (never the adopted file) and mark the record failed — but
 * only while it is still running/queued. A success committed by a
 * racing poll in between must not be reverted.
 */
export function markPollFailed(
  db: DatabaseSync,
  generationId: string,
  stagedFiles: string[] | undefined,
  cause: unknown,
): void {
  transact(db, () => {
    const cur = getGeneration(db, generationId);
    dropStagedOutputs(db, cur, stagedFiles);
    if (cur.status === "running" || cur.status === "queued") {
      updateGenerationStatus(db, {
        id: cur.id,
        status: "failed",
        error: `output registration failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      });
    }
  });
}

/**
 * The bundled FastH3 graph is the only verified camera_work prompt
 * path. A user-selected workflow qualifies only when its graph content
 * is identical — a modified same-name file is NOT treated as verified.
 * The default video path is Wan2.2, so an absent selection never
 * counts as FastH3; FastH3 camera direction needs an explicit
 * fasth3-equal selection.
 */
let _bundledFasth3: { graph: unknown; sha256: string } | undefined;
function bundledFasth3() {
  if (!_bundledFasth3) {
    const raw = readFileSync(
      new URL("../gen/workflows/fasth3_i2v.json", import.meta.url),
      "utf8",
    );
    _bundledFasth3 = {
      graph: JSON.parse(raw),
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  }
  return _bundledFasth3;
}

/** Verified-H3 condition shared by injection and any UI hint. */
export function isVerifiedCameraPath(
  kind: string,
  selection: { graph?: unknown } | null | undefined,
): boolean {
  if (kind !== "video") return false;
  // The Wan2.2 default path (no selection) is not FastH3 — camera
  // direction is injected only when the selected graph deep-equals the
  // bundled FastH3 graph.
  if (!selection?.graph) return false;
  try {
    return isDeepStrictEqual(selection.graph, bundledFasth3().graph);
  } catch {
    return false;
  }
}
