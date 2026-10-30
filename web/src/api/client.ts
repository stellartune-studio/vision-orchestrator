import type {
  Asset,
  BlueprintVersion,
  BlueprintVersionDetail,
  CharacterView,
  DocumentRevision,
  GenerationRecord,
  ItemRevision,
  ItemView,
  PostMessageResponse,
  ProductionDocument,
  Project,
  ProjectCharacter,
  ProjectListItem,
  ProjectState,
  QwenReferenceSize,
  SceneInputDraft,
  SceneInputDraftRecord,
  SceneInputDraftReview,
  SaveSceneInputDraftReviewRequest,
  SceneInputDraftSummary,
  SaveCharacterSheetRequest,
  SaveCharacterSheetResponse,
  SaveSceneInputDraftRequest,
  SaveWorkbenchBackgroundRequest,
  ServerMeta,
  WorkbenchBackground,
} from "@vo/shared";

/**
 * Feature code that calls fetch directly must still hand onError an
 * error carrying the real HTTP status — a bare Error collapses every
 * 4xx into "cannot reach the server" and hides the actionable message.
 */
export function apiError(
  status: number,
  payload: { error?: string; code?: string } | null,
): Error & { status: number; code?: string } {
  const err = new Error(payload?.error ?? `HTTP ${status}`) as Error & {
    status: number;
    code?: string;
  };
  err.status = status;
  err.code = payload?.code;
  return err;
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw apiError(res.status, json);
  }
  return json as T;
}

export const api = {
  meta: () => req<ServerMeta>("GET", "/api/meta"),
  listProjects: (archived = false) =>
    req<ProjectListItem[]>(
      "GET",
      `/api/projects${archived ? "?archived=1" : ""}`,
    ),
  setProjectArchived: (projectId: string, archived: boolean) =>
    req<Project>("PUT", `/api/projects/${projectId}/archive`, { archived }),
  deleteProject: (projectId: string) =>
    req<{ deleted: string }>("DELETE", `/api/projects/${projectId}`),
  createProject: (name: string) =>
    req<ProjectListItem>("POST", "/api/projects", { name }),
  state: (projectId: string) =>
    req<ProjectState>("GET", `/api/projects/${projectId}/state`),
  sendMessage: (
    projectId: string,
    content: string,
    documentRevisionId?: string,
  ) =>
    req<PostMessageResponse>("POST", `/api/projects/${projectId}/messages`, {
      content,
      document_revision_id: documentRevisionId,
    }),
  addRevision: (itemId: string, content: string) =>
    req<ItemRevision>("POST", `/api/items/${itemId}/revisions`, { content }),
  adopt: (itemId: string, revisionId: string, expectedVersion: number) =>
    req<ItemView>("POST", `/api/items/${itemId}/adopt`, {
      revision_id: revisionId,
      expected_version: expectedVersion,
    }),
  dismiss: (itemId: string, revisionId: string, expectedVersion: number) =>
    req<ItemView>("POST", `/api/items/${itemId}/proposals/${revisionId}/dismiss`, {
      expected_version: expectedVersion,
    }),
  createBlueprintVersion: (projectId: string, note?: string) =>
    req<BlueprintVersion>("POST", `/api/projects/${projectId}/blueprint-versions`, {
      note,
    }),
  blueprintVersion: (id: string) =>
    req<BlueprintVersionDetail>("GET", `/api/blueprint-versions/${id}`),
  /** Read-only scene instruction draft for the adopted revision —
   *  never persists or triggers generation. */
  sceneDraft: (
    projectId: string,
    blueprintVersionId: string,
    documentRevisionId: string,
  ) =>
    req<SceneInputDraft>(
      "GET",
      `/api/projects/${projectId}/scene-draft` +
        `?blueprint_version_id=${encodeURIComponent(blueprintVersionId)}` +
        `&document_revision_id=${encodeURIComponent(documentRevisionId)}`,
    ),
  listSceneInputDrafts: (projectId: string) =>
    req<SceneInputDraftSummary[]>(
      "GET",
      `/api/projects/${projectId}/scene-input-drafts`,
    ),
  sceneInputDraft: (projectId: string, draftId: string) =>
    req<SceneInputDraftRecord>(
      "GET",
      `/api/projects/${projectId}/scene-input-drafts/${draftId}`,
    ),
  sceneInputDraftReview: (projectId: string, draftId: string) =>
    req<SceneInputDraftReview>(
      "GET",
      `/api/projects/${projectId}/scene-input-drafts/${draftId}/review`,
    ),
  saveSceneInputDraftReview: (
    projectId: string,
    draftId: string,
    body: SaveSceneInputDraftReviewRequest,
  ) =>
    req<SceneInputDraftReview>(
      "PUT",
      `/api/projects/${projectId}/scene-input-drafts/${draftId}/review`,
      body,
    ),
  saveSceneInputDraft: (
    projectId: string,
    body: SaveSceneInputDraftRequest,
  ) =>
    req<SceneInputDraftRecord>(
      "POST",
      `/api/projects/${projectId}/scene-input-drafts`,
      body,
    ),
  createDocument: (
    projectId: string,
    kind: "script" | "storyboard",
    blueprintVersionId: string,
  ) =>
    req<{ document: ProductionDocument; revision: DocumentRevision }>(
      "POST",
      `/api/projects/${projectId}/documents`,
      { kind, blueprint_version_id: blueprintVersionId },
    ),
  adoptDocument: (docId: string, revisionId: string, expectedVersion: number) =>
    req<ProductionDocument>("POST", `/api/documents/${docId}/adopt`, {
      revision_id: revisionId,
      expected_version: expectedVersion,
    }),
  /**
   * Save a hand edit as a NEW pending revision. base_revision_id is
   * required — the saved draft inherits that revision's blueprint
   * link; without it the draft could never satisfy the gate.
   */
  addDocumentRevision: (
    docId: string,
    content: string,
    baseRevisionId: string,
  ) =>
    req<DocumentRevision>("POST", `/api/documents/${docId}/revisions`, {
      content,
      base_revision_id: baseRevisionId,
    }),
  listCharacters: () => req<CharacterView[]>("GET", "/api/characters"),
  createCharacter: (name: string) =>
    req<CharacterView>("POST", "/api/characters", { name }),
  addCharacterRevision: (
    characterId: string,
    profile: unknown,
    baseImageAssetId?: string,
  ) =>
    req("POST", `/api/characters/${characterId}/revisions`, {
      profile: typeof profile === "string" ? profile : JSON.stringify(profile),
      base_image_asset_id: baseImageAssetId,
    }),
  pinCharacter: (
    projectId: string,
    characterId: string,
    characterRevisionId: string,
    expectedVersion: number | null,
  ) =>
    req<ProjectCharacter>("PUT", `/api/projects/${projectId}/characters`, {
      character_id: characterId,
      character_revision_id: characterRevisionId,
      expected_version: expectedVersion,
    }),
  /**
   * Explicit sheet save — writes a NEW character revision and moves
   * this work's pin in one request. Never starts generation.
   */
  saveCharacterSheet: (
    projectId: string,
    body: SaveCharacterSheetRequest,
  ) =>
    req<SaveCharacterSheetResponse>(
      "PUT",
      `/api/projects/${projectId}/character-sheets`,
      body,
    ),
  /**
   * Persist this work's backdrop selection and pin state. A settings
   * write only — never starts generation.
   */
  saveWorkbenchBackground: (
    projectId: string,
    body: SaveWorkbenchBackgroundRequest,
  ) =>
    req<WorkbenchBackground>(
      "PUT",
      `/api/projects/${projectId}/workbench/background`,
      body,
    ),
  editVideo: (
    projectId: string,
    body: { source_asset_id: string; start_seconds: number; end_seconds: number; subtitles_srt?: string },
  ) =>
    req<{
      asset: Asset;
      source_asset_id: string;
      start_seconds: number;
      end_seconds: number;
      subtitle_sha256: string | null;
    }>("POST", `/api/projects/${projectId}/video-edits`, body),
  uploadAsset: (
    ownerKind: "project" | "character",
    ownerId: string,
    kind: string,
    name: string,
    contentBase64: string,
    mime?: string,
  ) =>
    req<Asset>("POST", "/api/assets", {
      owner_kind: ownerKind,
      owner_id: ownerId,
      kind,
      name,
      content_base64: contentBase64,
      mime,
    }),
  selectAsset: (assetId: string, selected: boolean, expectedVersion: number) =>
    req<Asset>("POST", `/api/assets/${assetId}/select`, { selected, expected_version: expectedVersion }),
  qwenReferenceSize: (projectId: string, blueprintVersionId: string) =>
    req<QwenReferenceSize>("POST", `/api/projects/${projectId}/qwen-reference-size`, { blueprint_version_id: blueprintVersionId }),
  generate: (
    projectId: string,
    blueprintVersionId: string,
    opts?: {
      kind?: "image" | "video";
      duration_seconds?: number;
      /** which approved document revision feeds the prompt — the
       *  server resolves it only when exactly one exists */
      document_revision_id?: string;
      /** Explicitly selected project image for the Qwen single-image edit profile. */
      edit_source_asset_id?: string;
      seed?: number;
      selection_version?: number;
      reference_size?: QwenReferenceSize;
    },
  ) =>
    req<GenerationRecord>("POST", `/api/projects/${projectId}/generations`, {
      blueprint_version_id: blueprintVersionId,
      kind: opts?.kind ?? "image",
      duration_seconds: opts?.duration_seconds,
      document_revision_id: opts?.document_revision_id,
      edit_source_asset_id: opts?.edit_source_asset_id,
      seed: opts?.seed,
      selection_version: opts?.selection_version,
      reference_size: opts?.reference_size,
    }),
  getGeneration: (id: string) =>
    req<GenerationRecord>("GET", `/api/generations/${id}`),
};

export function assetUrl(assetId: string): string {
  return `/api/assets/${assetId}/file`;
}

/**
 * Turn an API failure into a short, actionable message. Errors thrown by
 * `req` carry `status`/`code`; a bare TypeError means the request never
 * reached the server (offline, server down, aborted).
 */
export function describeError(e: unknown): string {
  const err = e as { message?: string; status?: number } | undefined;
  if (err?.status != null && err.message) return err.message;
  return "Cannot reach the server. Check that it is running, then try again.";
}
