import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  writeFileSync,
  createReadStream,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type {
  PostMessageResponse,
  ServerMeta,
} from "@vo/shared";
import { WORKBENCH_BACKDROPS } from "@vo/shared";
import { transact } from "../db/connection.ts";
import { newId } from "../domain/ids.ts";
import { templateKeyForPurpose } from "../domain/templates.ts";
import type { DirectorLLMProvider } from "../llm/provider.ts";
import {
  validateAmendment,
  validateProposals,
} from "../llm/proposalValidator.ts";
import type { GenerationBackend } from "../gen/backend.ts";
import { buildSceneDraftPreview, saveVerifiedSceneInputDraft } from "../domain/sceneDraft.ts";
import { checkProductionGate } from "../domain/productionGate.ts";
import {
  getSceneInputDraftReview,
  saveSceneInputDraftReview,
} from "../domain/sceneDraftReview.ts";
import {
  applyTemplate,
  createProject,
  deleteProject,
  getProject,
  listProjectSummaries,
  setProjectArchived,
  summarizeProjects,
} from "../repos/projects.ts";
import { getProjectState } from "../repos/views.ts";
import { insertMessage, listMessages } from "../repos/messages.ts";
import { insertAmendmentOutcome } from "../repos/outcomes.ts";
import {
  adoptRevision,
  dismissRevision,
  insertRevision,
  listItemViews,
} from "../repos/items.ts";
import {
  blueprintDriftNotes,
  blueprintFrozenContext,
  getBlueprintVersionDetail,
} from "../repos/blueprints.ts";
import {
  adoptDocumentRevision,
  dismissDocumentRevision,
  insertDocument,
  insertDocumentRevision,
  findDocumentRevision,
  getDocument,
  getDocumentRevision,
} from "../repos/documents.ts";
import {
  createCharacter,
  insertCharacterRevision,
  listCharacters,
  saveCharacterPin,
  saveCharacterSheet,
  toCharacterView,
} from "../repos/characters.ts";
import {
  insertAsset,
  getAsset,
  requireAssetOwner,
  setAssetSelected,
} from "../repos/assets.ts";
import {
  getSceneInputDraft,
  listSceneInputDrafts,
} from "../repos/sceneInputDrafts.ts";
import { saveWorkbenchBackground } from "../repos/workbench.ts";
import {
  BadRequestError,
  ConflictError,
  UnprocessableError,
} from "../repos/errors.ts";
import { isUnder, prepareDirUnder } from "../util/paths.ts";
import { checkedAssetType, mimeForPath } from "../util/media.ts";
import { Router, sendJson, type Ctx } from "./router.ts";
import type { ServerConfig } from "../config.ts";
import { registerGenerationRoutes } from "./generationRoutes.ts";
import { parseCharacterSheet } from "./characterSheetBody.ts";
import { registerBlueprintVersionRoutes } from "./blueprintVersionRoutes.ts";
import { registerStoryRoutes } from "./storyRoutes.ts";
import type { probeImageDimensions } from "../gen/imageDimensions.ts";
import { registerEnvironmentRoutes } from "./environmentRoutes.ts";
import { createEditedVideo } from "../editor/videoEdit.ts";
export { markPollFailed } from "./generationRoutes.ts";
export { checkProductionGate };

export interface AppDeps {
  db: DatabaseSync;
  config: ServerConfig;
  llm: DirectorLLMProvider;
  gen: GenerationBackend;
  probeDimensions?: typeof probeImageDimensions;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function buildRouter(deps: AppDeps): Router {
  const { db, config, llm, gen } = deps;
  const r = new Router();
  r.maxBodyBytes = config.max_body_bytes;
  registerEnvironmentRoutes(r, db, gen);

  r.get("/api/meta", (_c) => {
    const meta: ServerMeta = {
      node: process.version,
      llm_provider: config.llm_provider,
      gen_backend: config.gen_backend,
      gen_profile: config.gen_profile,
      gen_kinds: [...gen.capabilities.kinds],
      mock: llm.isMock || gen.isMock,
    };
    sendJson(_c.res, 200, meta);
  });

  // ---- projects ----

  r.get("/api/projects", (c) => {
    const q = new URL(c.req.url ?? "/", "http://localhost").searchParams;
    return sendJson(
      c.res,
      200,
      listProjectSummaries(db, q.get("archived") === "1" ? "only" : "exclude"),
    );
  });

  r.post("/api/projects", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const name = str(b.name);
    if (!name) throw new BadRequestError("name is required");
    const project = transact(db, () =>
      createProject(db, name, str(b.purpose_note)),
    );
    // Same shape as the list endpoint so the client can append it
    // without a refetch — a fresh project has an all-zero summary.
    const summary = summarizeProjects(db).get(project.id) ?? {
      adopted_items: 0,
      pending_proposals: 0,
      latest_version_no: null,
      latest_generation: null,
      latest_output_asset_id: null,
      latest_output_kind: null,
    };
    sendJson(c.res, 201, { ...project, summary });
  });

  // Reversible archive toggle — hides the work from the default library
  // list without touching any content. Unarchiving restores it fully.
  r.put("/api/projects/:id/archive", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    if (typeof b.archived !== "boolean") {
      throw new BadRequestError("archived (boolean) is required");
    }
    sendJson(c.res, 200, setProjectArchived(db, c.params.id, b.archived));
  });

  // Hard delete: removes the project and every project-owned row —
  // items/revisions, blueprint snapshots, documents, generations,
  // messages, drafts, and project-owned assets (rows AND files).
  // Shared-library characters and their assets are preserved.
  r.on("DELETE", "/api/projects/:id", (c) => {
    const result = deleteProject(db, c.params.id);
    let removed = 0;
    for (const p of result.asset_paths) {
      try {
        unlinkSync(p);
        removed++;
      } catch {
        // file already gone — the row removal still counts as deletion
      }
    }
    sendJson(c.res, 200, {
      deleted: c.params.id,
      asset_files_removed: removed,
    });
  });

  r.get("/api/projects/:id/state", (c) =>
    sendJson(c.res, 200, getProjectState(db, c.params.id)),
  );

  r.get("/api/projects/:id/scene-input-drafts", (c) =>
    sendJson(c.res, 200, listSceneInputDrafts(db, c.params.id)),
  );

  r.get("/api/projects/:id/scene-input-drafts/:draftId", (c) =>
    sendJson(c.res, 200, getSceneInputDraft(db, c.params.id, c.params.draftId)),
  );

  // Review progress is separate from the immutable saved snapshot.
  // GET is synthesized for an unsaved review and never creates a row.
  r.get("/api/projects/:id/scene-input-drafts/:draftId/review", (c) =>
    sendJson(
      c.res,
      200,
      getSceneInputDraftReview(db, c.params.id, c.params.draftId),
    ),
  );

  r.put("/api/projects/:id/scene-input-drafts/:draftId/review", (c) =>
    sendJson(
      c.res,
      200,
      saveSceneInputDraftReview(db, c.params.id, c.params.draftId, c.body),
    ),
  );

  r.post("/api/projects/:id/scene-input-drafts", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const allowed = new Set([
      "blueprint_version_id", "document_id", "document_revision_id", "digest",
    ]);
    if (Object.keys(b).some((key) => !allowed.has(key))) {
      throw new BadRequestError(
        "save requests accept only target IDs and the preview digest",
      );
    }
    const blueprintVersionId = str(b.blueprint_version_id);
    const documentId = str(b.document_id);
    const documentRevisionId = str(b.document_revision_id);
    const digest = str(b.digest);
    if (!blueprintVersionId || !documentId || !documentRevisionId || !digest) {
      throw new BadRequestError(
        "blueprint_version_id, document_id, document_revision_id, and digest are required",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new BadRequestError("digest must be a SHA-256 hex string");
    }
    const saved = saveVerifiedSceneInputDraft(db, {
      project_id: c.params.id,
      blueprint_version_id: blueprintVersionId,
      document_id: documentId,
      document_revision_id: documentRevisionId,
      digest,
    });
    sendJson(c.res, 201, saved);
  });

  // ---- conversation ----

  r.post("/api/projects/:id/messages", async (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const content = str(b.content);
    if (!content) throw new BadRequestError("content is required");
    const projectId = c.params.id;
    getProject(db, projectId);

    // A revision directive routes to the amend flow — the validated
    // server-side target decides the save destination, never any id
    // the model emits.
    const directiveRev = str(b.document_revision_id);
    if (directiveRev) {
      sendJson(
        c.res,
        200,
        await amendDocumentViaDirective(db, llm, projectId, content, directiveRev),
      );
      return;
    }

    // 1. persist the user turn
    transact(db, () =>
      insertMessage(db, { project_id: projectId, role: "user", content }),
    );

    // 2. build LLM context from DB state (no transaction held open)
    const items = listItemViews(db, projectId);
    const history = listMessages(db, projectId).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const characters = db
      .prepare(
        `SELECT c.name, cr.profile, cr.base_image_asset_id
           FROM project_characters pc
           JOIN characters c ON c.id = pc.character_id
           JOIN character_revisions cr ON cr.id = pc.character_revision_id
          WHERE pc.project_id = ?`,
      )
      .all(projectId)
      .map((row) => {
        const r = row as {
          name: string;
          profile: string;
          base_image_asset_id: string | null;
        };
        let locked: Record<string, string> = {};
        try {
          locked =
            (JSON.parse(r.profile) as { traits?: { locked?: Record<string, string> } })
              .traits?.locked ?? {};
        } catch {
          locked = {};
        }
        return {
          name: r.name,
          locked_traits: locked,
          has_base_image: r.base_image_asset_id != null,
        };
      });

    // 3. call the provider — no DB transaction is open here
    const out = await llm.converse({
      project_name: getProject(db, projectId).name,
      messages: history,
      items,
      characters,
    });

    // 4. validate proposals server-side; invalid drafts are reported,
    //    never saved
    const { valid, rejected } = validateProposals(out.proposals, items);

    // 5. persist assistant reply + proposal revisions in ONE txn
    const saved = transact(db, () => {
      insertMessage(db, {
        project_id: projectId,
        role: "assistant",
        content: out.reply,
      });
      return valid.map((p) => ({
        item_id: p.item_id,
        revision: insertRevision(db, {
          item_id: p.item_id,
          content: p.content,
          source: "llm",
          base_state_version: p.base_state_version,
        }),
      }));
    });

    sendJson(c.res, 200, {
      reply: out.reply,
      proposals: saved,
      rejected_proposals: rejected,
    });
  });

  // ---- items / revisions ----

  r.post("/api/items/:id/revisions", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const content = str(b.content);
    if (!content) throw new BadRequestError("content is required");
    const rev = transact(db, () =>
      insertRevision(db, {
        item_id: c.params.id,
        content,
        source: "user",
      }),
    );
    sendJson(c.res, 201, rev);
  });

  r.post("/api/items/:id/adopt", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const revision_id = str(b.revision_id);
    const expected_version = num(b.expected_version);
    if (!revision_id || expected_version === undefined) {
      throw new BadRequestError("revision_id and expected_version are required");
    }
    const result = transact(db, () => {
      const view = adoptRevision(db, {
        item_id: c.params.id,
        revision_id,
        expected_version,
      });
      // Adopting a purpose applies the matching template (adds missing
      // items as undecided; never rewrites existing ones).
      if (view.kind === "purpose" && view.adopted_revision) {
        const key = templateKeyForPurpose(view.adopted_revision.content);
        if (key) applyTemplate(db, view.project_id, key);
      }
      return view;
    });
    sendJson(c.res, 200, result);
  });

  r.post("/api/items/:id/proposals/:rev/dismiss", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const expected_version = num(b.expected_version);
    if (expected_version === undefined) {
      throw new BadRequestError("expected_version is required");
    }
    const view = transact(db, () =>
      dismissRevision(db, {
        item_id: c.params.id,
        revision_id: c.params.rev,
        expected_version,
      }),
    );
    sendJson(c.res, 200, view);
  });

  // ---- blueprint versions ----
  registerBlueprintVersionRoutes(r, db);
  registerStoryRoutes(r, db, config);

  // ---- scene input draft (read-only preview — no writes, no
  // backend calls; requires the document's CURRENT adopted revision
  // derived from the given blueprint version) ----
  r.get("/api/projects/:id/scene-draft", (c) => {
    const q = new URL(c.req.url ?? "/", "http://localhost").searchParams;
    const bvId = q.get("blueprint_version_id");
    const revId = q.get("document_revision_id");
    if (!bvId || !revId) {
      throw new BadRequestError(
        "blueprint_version_id and document_revision_id are required",
      );
    }
    sendJson(
      c.res,
      200,
      buildSceneDraftPreview(db, {
        project_id: c.params.id,
        blueprint_version_id: bvId,
        document_revision_id: revId,
      }),
    );
  });

  // ---- production documents ----

  r.post("/api/projects/:id/documents", async (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const kind = str(b.kind);
    const bvId = str(b.blueprint_version_id);
    if (kind !== "script" && kind !== "storyboard") {
      throw new BadRequestError('kind must be "script" or "storyboard"');
    }
    const projectId = c.params.id;
    if (bvId) {
      const bv = getBlueprintVersionDetail(db, bvId);
      if (bv.project_id !== projectId) {
        throw new BadRequestError("blueprint version belongs to another project");
      }
    }

    const doc = transact(db, () =>
      insertDocument(db, { project_id: projectId, kind, title: str(b.title) }),
    );

    // Draft generation happens OUTSIDE a transaction.
    let draftText = "";
    if (bvId) {
      const bv = getBlueprintVersionDetail(db, bvId);
      const parts: string[] = [];
      for (const item of bv.items) {
        const rev = db
          .prepare("SELECT content FROM item_revisions WHERE id = ?")
          .get(item.revision_id) as { content: string } | undefined;
        if (rev) parts.push(`[${item.kind}] ${item.label}: ${rev.content}`);
      }
      const out = await llm.converse({
        project_name: getProject(db, projectId).name,
        messages: [
          {
            role: "user",
            content:
              `Draft a ${kind} from the approved blueprint below. ` +
              `Reply with the document text only.\n\n` + parts.join("\n"),
          },
        ],
        items: [],
        characters: [],
      });
      draftText = out.reply || parts.join("\n");
    }

    const rev = transact(db, () =>
      insertDocumentRevision(db, {
        document_id: doc.id,
        content: draftText || "(empty draft)",
        source: bvId ? "llm" : "user",
        blueprint_version_id: bvId ?? null,
      }),
    );
    sendJson(c.res, 201, { document: getDocument(db, doc.id), revision: rev });
  });

  r.post("/api/documents/:id/revisions", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const content = str(b.content);
    if (!content) throw new BadRequestError("content is required");
    const rev = transact(db, () =>
      insertDocumentRevision(db, {
        document_id: c.params.id,
        content,
        source: "user",
        blueprint_version_id: resolveDocRevisionBlueprint(
          db,
          c.params.id,
          b,
        ),
      }),
    );
    sendJson(c.res, 201, rev);
  });

  r.post("/api/documents/:id/adopt", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const revision_id = str(b.revision_id);
    const expected_version = num(b.expected_version);
    if (!revision_id || expected_version === undefined) {
      throw new BadRequestError("revision_id and expected_version are required");
    }
    const doc = transact(db, () =>
      adoptDocumentRevision(db, {
        document_id: c.params.id,
        revision_id,
        expected_version,
      }),
    );
    sendJson(c.res, 200, doc);
  });

  r.post("/api/documents/:id/proposals/:rev/dismiss", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const expected_version = num(b.expected_version);
    if (expected_version === undefined) {
      throw new BadRequestError("expected_version is required");
    }
    const doc = transact(db, () =>
      dismissDocumentRevision(db, {
        document_id: c.params.id,
        revision_id: c.params.rev,
        expected_version,
      }),
    );
    sendJson(c.res, 200, doc);
  });

  // ---- characters ----

  r.get("/api/characters", (c) =>
    sendJson(
      c.res,
      200,
      listCharacters(db).map((ch) => toCharacterView(db, ch)),
    ),
  );

  r.post("/api/characters", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const name = str(b.name);
    if (!name) throw new BadRequestError("name is required");
    sendJson(c.res, 201, transact(db, () => createCharacter(db, name)));
  });

  r.post("/api/characters/:id/revisions", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const profile = typeof b.profile === "string" ? b.profile : JSON.stringify(b.profile ?? {});
    const rev = transact(db, () =>
      insertCharacterRevision(db, {
        character_id: c.params.id,
        profile,
        base_image_asset_id: str(b.base_image_asset_id) ?? null,
      }),
    );
    sendJson(c.res, 201, rev);
  });

  r.put("/api/projects/:id/characters", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const character_id = str(b.character_id);
    const character_revision_id = str(b.character_revision_id);
    if (!character_id || !character_revision_id) {
      throw new BadRequestError("character_id and character_revision_id are required");
    }
    if (!("expected_version" in b) || (b.expected_version !== null && (!Number.isSafeInteger(b.expected_version) || Number(b.expected_version) < 1))) throw new BadRequestError("expected_version must be the current pin version or null");
    const pin = transact(db, () =>
      saveCharacterPin(db, {
        project_id: c.params.id,
        character_id,
        character_revision_id,
        expected_version: b.expected_version as number | null,
      }),
    );
    sendJson(c.res, 200, pin);
  });

  // Explicit workbench sheet save — the single route that both writes
  // a character revision and moves the work's pin, in one
  // transaction. Saving never calls an LLM or a generation backend.
  r.put("/api/projects/:id/character-sheets", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const allowed = new Set([
      "character_id",
      "name",
      "sheet",
      "base_revision_id",
      "base_image_asset_id",
      "expected_revision_id",
    ]);
    if (Object.keys(b).some((key) => !allowed.has(key))) {
      throw new BadRequestError(
        "sheet saves accept only character_id, name, sheet, " +
          "base_revision_id, base_image_asset_id and expected_revision_id",
      );
    }
    const characterId = str(b.character_id);
    const name = str(b.name);
    if (!characterId && !name) {
      throw new BadRequestError("character_id or name is required");
    }
    // name + character_id together is a rename inside the save
    if (b.name !== undefined && !name) {
      throw new BadRequestError("name must be a non-empty string");
    }
    const baseImageAssetId = str(b.base_image_asset_id);
    if (b.base_image_asset_id !== undefined && !baseImageAssetId) {
      throw new BadRequestError("base_image_asset_id must be a string");
    }
    if (!("expected_revision_id" in b)) {
      throw new BadRequestError("expected_revision_id is required");
    }
    const expected = b.expected_revision_id;
    if (expected !== null && typeof expected !== "string") {
      throw new BadRequestError(
        "expected_revision_id must be a revision id or null",
      );
    }
    const sheet = parseCharacterSheet(b.sheet);
    getProject(db, c.params.id);
    const saved = transact(db, () =>
      saveCharacterSheet(db, {
        project_id: c.params.id,
        character_id: characterId,
        name,
        sheet,
        base_revision_id: str(b.base_revision_id),
        base_image_asset_id: baseImageAssetId,
        expected_revision_id: expected,
      }),
    );
    sendJson(c.res, characterId ? 200 : 201, saved);
  });

  // Workbench backdrop selection + pin — a per-work settings write,
  // version-guarded like the sheet pin. Never calls an LLM or a
  // generation backend.
  r.put("/api/projects/:id/workbench/background", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const bgAllowed = new Set(["backdrop_key", "locked", "expected_version"]);
    if (Object.keys(b).some((k) => !bgAllowed.has(k))) {
      throw new BadRequestError(
        "background saves accept only backdrop_key, locked, expected_version",
      );
    }
    const backdropKey = str(b.backdrop_key);
    if (
      !backdropKey ||
      !(WORKBENCH_BACKDROPS as readonly string[]).includes(backdropKey)
    ) {
      throw new BadRequestError("unknown backdrop_key");
    }
    if (typeof b.locked !== "boolean") {
      throw new BadRequestError("locked must be a boolean");
    }
    if (
      b.expected_version !== null &&
      !Number.isInteger(b.expected_version)
    ) {
      throw new BadRequestError("expected_version is required");
    }
    getProject(db, c.params.id);
    const saved = saveWorkbenchBackground(db, {
      project_id: c.params.id,
      backdrop_key: backdropKey,
      locked: b.locked,
      expected_version: b.expected_version as number | null,
    });
    sendJson(c.res, 200, saved);
  });

  // ---- assets ----

  r.post("/api/assets", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const owner_kind = str(b.owner_kind);
    const owner_id = str(b.owner_id);
    const kind = str(b.kind);
    const name = str(b.name) ?? "asset";
    const content_base64 = str(b.content_base64);
    if (owner_kind !== "project" && owner_kind !== "character") {
      throw new BadRequestError('owner_kind must be "project" or "character"');
    }
    if (!owner_id || !kind || !content_base64) {
      throw new BadRequestError("owner_id, kind, content_base64 are required");
    }
    // Owner must exist BEFORE any filesystem work — rejected uploads
    // leave no directories or files behind.
    requireAssetOwner(db, owner_kind, owner_id);
    const bytes = Buffer.from(content_base64, "base64");
    if (bytes.length === 0) throw new BadRequestError("empty asset content");
    // Extension, declared mime and content signature must all agree on
    // ONE allowlisted media type; the caller's name/mime are never
    // trusted for storage or serving.
    const { ext, mime } = checkedAssetType(name, str(b.mime), bytes);
    // Stored name is server-generated; the dir is proven to sit inside
    // assets_root even through symlinks/junctions.
    const dir = prepareDirUnder(config.assets_root, owner_id);
    const file = join(dir, `${newId()}${ext}`);
    writeFileSync(file, bytes, { flag: "wx" });
    let asset;
    try {
      asset = transact(db, () =>
        insertAsset(db, {
          owner_kind,
          owner_id,
          kind,
          path: file,
          mime,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    } catch (err) {
      // DB registration failed — do not leave an orphan file behind.
      try {
        unlinkSync(file);
      } catch {
        // file may already be gone
      }
      throw err;
    }
    sendJson(c.res, 201, asset);
  });

  r.post("/api/assets/:id/select", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    if (typeof b.selected !== "boolean" || !Number.isSafeInteger(b.expected_version) || Number(b.expected_version) < 0) throw new BadRequestError("selected and expected_version are required");
    const asset = transact(db, () => setAssetSelected(db, c.params.id, b.selected as boolean, b.expected_version as number));
    sendJson(c.res, 200, asset);
  });

  r.get("/api/assets/:id/file", (c) => {
    const asset = getAsset(db, c.params.id);
    // Serve only files whose REAL path sits inside the storage root
    // (link targets resolve to their true location) and whose type is
    // allowlisted — the stored mime is never trusted.
    let realFile: string | null = null;
    try {
      const candidate = realpathSync(asset.path);
      if (isUnder(realpathSync(config.assets_root), candidate)) {
        realFile = candidate;
      }
    } catch {
      // missing file / missing root — handled below as 404
    }
    const mime = realFile ? mimeForPath(realFile) : undefined;
    if (!realFile || !mime || !statSync(realFile).isFile()) {
      sendJson(c.res, 404, { error: "asset file missing" });
      return;
    }
    c.res.writeHead(200, {
      "content-type": mime,
      "content-length": statSync(realFile).size,
      "x-content-type-options": "nosniff",
    });
    createReadStream(realFile).pipe(c.res);
  });

  // ---- generations ----
  registerGenerationRoutes(r, { db, config, gen, checkProductionGate, probeDimensions: deps.probeDimensions });

  // Edits always create a new derived asset; the source and its history remain unchanged.
  r.post("/api/projects/:id/video-edits", async (c) => {
    const result = await createEditedVideo(db, c.params.id, c.body, {
      ffmpeg_bin: config.ffmpeg_bin ?? "ffmpeg",
      ffprobe_bin: config.ffprobe_bin ?? "ffprobe",
      assets_root: config.assets_root,
    });
    sendJson(c.res, 201, result);
  });
  return r;
}

/**
 * Source blueprint version for a hand-written document revision.
 * An explicit `blueprint_version_id` re-bases the draft onto another
 * snapshot; otherwise the edit inherits the lineage of the revision
 * it builds on (`base_revision_id`, else the currently adopted one).
 * A revision without the link can never satisfy the production gate,
 * so losing it here would silently orphan the document.
 */
function resolveDocRevisionBlueprint(
  db: DatabaseSync,
  documentId: string,
  body: Record<string, unknown>,
): string | null {
  const doc = getDocument(db, documentId);
  // A claimed edit base is validated even when an explicit re-base
  // follows — a foreign revision id is never silently ignored.
  const baseId = str(body.base_revision_id);
  const base = baseId
    ? getDocumentRevision(db, documentId, baseId)
    : undefined;
  const explicit = str(body.blueprint_version_id);
  if (explicit) {
    const bv = getBlueprintVersionDetail(db, explicit);
    if (bv.project_id !== doc.project_id) {
      throw new BadRequestError(
        "blueprint version belongs to another project",
      );
    }
    return explicit;
  }
  if (base) return base.blueprint_version_id;
  const adopted = doc.adopted_revision_id
    ? findDocumentRevision(db, doc.adopted_revision_id)
    : undefined;
  return adopted?.blueprint_version_id ?? null;
}

/**
 * Message route with a revision directive: the instruction targets one
 * concrete revision. The user turn is persisted, the LLM drafts against
 * frozen context built from the SAME validated revision (never ids the
 * model emits), and a well-formed amendment lands as a new pending
 * revision — without touching the adopted pointer or proposal history.
 *
 * If the document's state_version moved while the call was in flight
 * (e.g. a revision was adopted), saving is aborted with 409: the reply
 * was drafted on stale premises and must not masquerade as fresh.
 * The rollback covers the assistant reply and the amendment draft —
 * the user turn persisted BEFORE the call intentionally survives, so
 * the directive itself is never lost (same rule as the UI draft box).
 */
async function amendDocumentViaDirective(
  db: DatabaseSync,
  llm: DirectorLLMProvider,
  projectId: string,
  instruction: string,
  revisionId: string,
): Promise<PostMessageResponse> {
  const base = findDocumentRevision(db, revisionId);
  const doc = base ? getDocument(db, base.document_id) : null;
  if (!base || !doc || doc.project_id !== projectId) {
    throw new BadRequestError(
      "document_revision_id must be a revision of this project's document",
    );
  }
  const versionAtRequest = doc.state_version;
  const frozenContext = base.blueprint_version_id
    ? blueprintFrozenContext(db, base.blueprint_version_id)
    : null;
  const driftNotes = base.blueprint_version_id
    ? blueprintDriftNotes(db, base.blueprint_version_id)
    : [];

  const userMsg = transact(db, () =>
    insertMessage(db, {
      project_id: projectId,
      role: "user",
      content: instruction,
    }),
  );
  const history = listMessages(db, projectId).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const out = await llm.reviseDocument({
    project_name: getProject(db, projectId).name,
    instruction,
    messages: history,
    document: {
      kind: doc.kind,
      title: doc.title,
      base_rev_no: base.rev_no,
      base_status: base.proposal_status,
      base_content: base.content,
    },
    frozen_context: frozenContext,
    drift_notes: driftNotes,
  });
  // amendment_error means the provider could not even read the block —
  // it preempts any payload it happened to carry alongside.
  const amendment =
    out.amendment === undefined || out.amendment_error
      ? null
      : validateAmendment(out.amendment);
  const rejectedAmendment =
    out.amendment_error ??
    (amendment && !amendment.ok ? amendment.reason : undefined);
  const saved = transact(db, () => {
    const fresh = getDocument(db, doc.id);
    if (fresh.state_version !== versionAtRequest) {
      throw new ConflictError(
        "document changed while the amendment was being drafted — re-check and retry",
      );
    }
    const replyMsg = insertMessage(db, {
      project_id: projectId,
      role: "assistant",
      content: out.reply,
    });
    const rev = amendment?.ok
      ? insertDocumentRevision(db, {
          document_id: doc.id,
          content: amendment.content,
          source: "llm",
          blueprint_version_id: base.blueprint_version_id,
          base_revision_id: base.id,
          instruction_message_id: userMsg.id,
        })
      : null;
    // reply + revision + outcome commit together — a reload always
    // sees a consistent trio, and an aborted 409 writes none of them
    insertAmendmentOutcome(db, {
      project_id: projectId,
      instruction_message_id: userMsg.id,
      assistant_message_id: replyMsg.id,
      document_id: doc.id,
      base_revision_id: base.id,
      blueprint_version_id: base.blueprint_version_id,
      outcome: rev ? "saved" : rejectedAmendment ? "rejected" : "reply_only",
      result_revision_id: rev?.id ?? null,
      reject_reason: rev ? null : (rejectedAmendment ?? null),
    });
    return rev;
  });
  return {
    reply: out.reply,
    proposals: [],
    rejected_proposals: [],
    document_revision: saved,
    ...(rejectedAmendment ? { rejected_amendment: rejectedAmendment } : {}),
  };
}
