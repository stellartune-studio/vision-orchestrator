import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  CharacterProfile,
  SceneDraftCheckStatus,
  SceneDraftQuestion,
  SceneDraftSection,
  SceneDraftSource,
  SceneDraftUnresolvedSource,
  SceneInputDraft,
  SceneInputDraftContent,
  SceneInputDraftRecord,
} from "@vo/shared";
import { getBlueprintVersionDetail } from "../repos/blueprints.ts";
import { findDocumentRevision, getDocument } from "../repos/documents.ts";
import { findItemRevision } from "../repos/items.ts";
import { getCharacter, getCharacterRevision } from "../repos/characters.ts";
import { findAsset } from "../repos/assets.ts";
import { ConflictError, UnprocessableError } from "../repos/errors.ts";
import { transact } from "../db/connection.ts";
import {
  insertSceneInputDraft,
  validateSceneInputDraftTarget,
} from "../repos/sceneInputDrafts.ts";
import { safeBasename } from "../util/paths.ts";
import { parseSceneDesignation } from "./sceneDesignation.ts";
export { parseSceneDesignation };

/**
 * Deterministic one-scene instruction DRAFT — a preview reorganization
 * of already-approved content, never a generation input.
 *
 *   - scene text, constraints, context and unclassified notes are
 *     carried over VERBATIM from their approved revisions (nothing
 *     paraphrased, weakened or auto-resolved)
 *   - piece-level descriptions (intent etc.) go to `context`, the
 *     scene's own text to `scene` — the two scopes are never merged
 *   - every check result reports its inspection coverage:
 *     related text found / none found in the inspected range /
 *     relevant sources not inspected. A keyword match is a LOCATOR
 *     for related text only — never evidence of a decision
 *   - blueprint references that cannot be resolved are reported in
 *     `unresolved_sources`, never silently skipped
 *   - asset CONTENT is never inspected: selected assets are listed
 *     as reference-only and their presence must not be read as
 *     "no related instruction". Filenames and labels are never used
 *     as content evidence.
 *
 * Scene designation formats the draft accepts (and only these):
 *   場面[:：]  /  場面N[:：]  /  シーンN[:：]
 * Anything else — including English "Scene N" or a numberless
 * シーン heading — is NOT recognised. Zero recognised markers is
 * not evidence of a single scene; the draft refuses and asks for an
 * explicit target instead of guessing a boundary.
 */

const POSTURE_RE =
  /歩く|歩い|歩き|座る|座り|座っ|立つ|立ち|立っ|走る|走り|走っ|跳|飛|寝|屈|蹲|伏せ|振り向|見上げ|見下ろ|止ま|止め|walk|walks|walking|sit|sits|sitting|stand|stands|standing|run|runs|running|jump|fly|lying|look up/i;
/** Locators for RELATED text — they find lines worth showing to the
 *  director; they never decide that an aspect is agreed. Phrases like
 *  「アニメか実写か未定」 match and stay visible as related text. */
const STYLE_RE =
  /アニメ|イラスト|写実|実写|絵画|水彩|油絵|漫画|版画|写真|画風|スタイル|anime|illustrat|manga|photo|realist|paint|watercolor|cel.?shad|style/i;
const COLOR_RE =
  /カラー|モノクロ|白黒|色彩|色調|暖色|寒色|セピア|モノトーン|monochrome|black.?and.?white|colou?r|sepia|b&w/i;
/** main-subject count cues — kept separate from background people */
const MAIN_SUBJECT_RE =
  /主役|主人公|ヒロイン|人数|一人|１人|二人|２人|三人|３人|単独|独り|protagonist|hero|heroine|single|alone/i;
const BACKGROUND_PEOPLE_RE =
  /背景人物|通行人|群衆|群れ|大勢|モブ|脇役|extras?|crowd|bystanders?|passers?by|background (people|characters?)/i;
const COMPOSITION_RE =
  /構図|俯瞰|アングル|アップ|引き|ロングショット|カメラ|レンズ|広角|望遠|煽り|wide.?shot|close.?up|composition|camera|lens|low.?angle|high.?angle/i;
const NEGATIVE_RE =
  /negative|ネガティブ|描かない|描けない|除外|禁止|除く|入れない/i;

export const SCENE_DRAFT_PAYLOAD_VERSION = 1;
export const SCENE_DRAFT_BUILDER_VERSION = 1;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value).sort().map((key) => [
            key,
            canonical((value as Record<string, unknown>)[key]),
          ]),
        )
      : value;

function sceneDraftDigest(draft: Omit<SceneInputDraft, "digest">): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(draft)))
    .digest("hex");
}

const CONTEXT_KINDS = new Set([
  "intent",
  "audience",
  "worldview",
  "story_segment",
  // shot items are included verbatim as piece-level context — the
  // draft never selects one shot as "the" relevant one
  "shot",
]);

export function buildSceneDraft(
  db: DatabaseSync,
  args: {
    project_id: string;
    blueprint_version_id: string;
    document_revision_id: string;
  },
): SceneInputDraftContent {
  const bv = getBlueprintVersionDetail(db, args.blueprint_version_id);
  if (bv.project_id !== args.project_id) {
    throw new UnprocessableError(
      "blueprint version belongs to another project",
    );
  }

  const rev = findDocumentRevision(db, args.document_revision_id);
  const doc = rev ? getDocument(db, rev.document_id) : undefined;
  if (!rev || !doc || doc.project_id !== args.project_id) {
    throw new UnprocessableError(
      "document revision belongs to another project",
    );
  }
  // The draft must describe the version the director would actually
  // generate from — a superseded or merely-pending revision is not a
  // valid target.
  if (doc.adopted_revision_id !== rev.id) {
    throw new UnprocessableError(
      "scene draft requires the document's currently adopted revision",
    );
  }
  if (rev.blueprint_version_id !== bv.id) {
    throw new UnprocessableError(
      "document revision is not derived from this blueprint version",
    );
  }
  // Never silently pick "the first scene" and never treat "no
  // recognised marker" as proof of a single scene — the document
  // must carry one designation in the ACCEPTED format.
  const designation = parseSceneDesignation(rev.content);
  if (!designation.ok) throw new UnprocessableError(designation.reason);

  const unresolved_sources: SceneDraftUnresolvedSource[] = [];
  const itemContent = (revisionId: string, src: SceneDraftSource) => {
    const r = findItemRevision(db, revisionId);
    if (!r) {
      // Referenced by the frozen version but not resolvable —
      // reported, never skipped. (A found-but-empty revision still
      // becomes a normal section.)
      unresolved_sources.push({ source: src, reason: "not_found" });
      return undefined;
    }
    return r.content;
  };

  const constraints: SceneDraftSection[] = [];
  const constraintByNorm = new Map<string, SceneDraftSection>();
  const pushConstraint = (content: string, source: SceneDraftSource) => {
    const norm = content.replace(/\s+/g, " ").trim();
    const existing = constraintByNorm.get(norm);
    if (existing) {
      // Identical condition from another source — keep ONE entry
      // holding every provenance. Merely-similar text is NOT merged.
      existing.sources.push(source);
      return;
    }
    const section: SceneDraftSection = { content, sources: [source] };
    constraintByNorm.set(norm, section);
    constraints.push(section);
  };

  const context: SceneDraftSection[] = [];
  const unclassified: SceneDraftSection[] = [];
  for (const i of [...bv.items].sort((a, b) =>
    a.kind === b.kind ? a.seq - b.seq : a.kind < b.kind ? -1 : 1,
  )) {
    const src: SceneDraftSource = {
      kind: "item_revision",
      id: i.revision_id,
      label: `${i.kind}: ${i.label}`,
    };
    const c = itemContent(i.revision_id, src);
    if (c === undefined) continue;
    if (i.kind === "fixed_constraint") {
      pushConstraint(c, src);
    } else if (CONTEXT_KINDS.has(i.kind)) {
      context.push({ content: c, sources: [src] });
    } else {
      // Adopted text with no scene/constraint meaning the draft can
      // classify (output policy, purpose, material notes, ...) —
      // kept verbatim instead of being dropped.
      unclassified.push({ content: c, sources: [src] });
    }
  }

  const ref_assets: SceneInputDraft["ref_assets"] = [];
  const uninspected_sources: SceneDraftSource[] = [];
  for (const chr of bv.characters) {
    const charSrc: SceneDraftSource = {
      kind: "character_revision",
      id: chr.character_revision_id,
      label: undefined,
    };
    const profileText = getCharacterRevision(
      db,
      chr.character_revision_id,
    )?.profile;
    const chr0 = getCharacter(db, chr.character_id);
    if (!chr0) {
      unresolved_sources.push({
        source: {
          kind: "character_revision",
          id: chr.character_revision_id,
          label: `Character ${chr.character_id.slice(0, 8)}`,
        },
        reason: "not_found",
      });
    }
    const name = chr0?.name ?? chr.character_id;
    charSrc.label = `Character ${name}`;
    if (profileText === undefined) {
      unresolved_sources.push({ source: charSrc, reason: "not_found" });
    } else if (profileText) {
      try {
        const profile = JSON.parse(profileText) as CharacterProfile;
        const locked = profile.traits?.locked ?? {};
        const traitText = Object.entries(locked)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        if (traitText) pushConstraint(traitText, charSrc);
        if (profile.appearance) {
          context.push({ content: profile.appearance, sources: [charSrc] });
        }
      } catch {
        context.push({ content: profileText, sources: [charSrc] });
      }
    }
    if (chr.base_image_asset_id) {
      const label = `Reference image for character ${name}`;
      const src: SceneDraftSource = {
        kind: "asset",
        id: chr.base_image_asset_id,
        label,
      };
      // Resolve the base image through the repo like any other
      // selected asset: a missing RECORD is an unresolved source,
      // never a "verified reference". (Verification level: the DB
      // record exists — file bytes and content are NOT inspected.)
      if (findAsset(db, chr.base_image_asset_id)) {
        ref_assets.push({
          id: chr.base_image_asset_id,
          label,
          content_inspected: false,
        });
        uninspected_sources.push(src);
      } else {
        unresolved_sources.push({ source: src, reason: "not_found" });
      }
    }
  }

  for (const a of bv.assets) {
    const asset = findAsset(db, a.asset_id);
    const src: SceneDraftSource = {
      kind: "asset",
      id: a.asset_id,
      label: asset ? safeBasename(asset.path) : a.asset_id.slice(0, 8),
    };
    if (!asset) {
      unresolved_sources.push({ source: src, reason: "not_found" });
      continue;
    }
    // No asset content is inspected — image or text, the draft only
    // confirms the reference exists. Filenames are never used as
    // content evidence.
    if (asset.mime?.startsWith("image/")) {
      ref_assets.push({
        id: asset.id,
        label: safeBasename(asset.path),
        content_inspected: false,
      });
    }
    uninspected_sources.push(src);
  }

  // ---- checks over the INSPECTED text only ----
  const docSrc: SceneDraftSource = {
    kind: "document_revision",
    id: rev.id,
    label: "",
  };
  const docLabel = doc.title || (doc.kind === "script" ? "Script" : "Storyboard");
  docSrc.label = `${docLabel} v${rev.rev_no}`;
  const scene: SceneDraftSection = {
    content: rev.content,
    sources: [docSrc],
  };

  const inspectedSections = [
    scene,
    ...constraints,
    ...context,
    ...unclassified,
  ];
  // Locate verbatim lines related to an aspect. The matched line is
  // displayed exactly as written — including "未定" or "候補" wording;
  // nothing is promoted to a decided condition.
  const relatedTo = (re: RegExp): SceneDraftSection[] => {
    const out: SceneDraftSection[] = [];
    for (const sec of inspectedSections) {
      for (const line of sec.content.split("\n")) {
        if (re.test(line)) out.push({ content: line, sources: sec.sources });
      }
    }
    return out;
  };

  const open_questions: SceneDraftQuestion[] = [];
  const pushQuestion = (
    kind: SceneDraftQuestion["kind"],
    aspect: string,
    re: RegExp | null,
    sources: SceneDraftSource[] = [],
  ) => {
    const related = re ? relatedTo(re) : [];
    const uninspected = uninspected_sources;
    const status: SceneDraftCheckStatus = uninspected.length
      ? "not_inspected"
      : related.length
        ? "related_text_found"
        : "none_found";
    const note =
      status === "not_inspected"
        ? `${aspect}: some references were not inspected, so coverage is incomplete. ` +
          (related.length
            ? "Related text was also found in inspected sources — the director should confirm interpretation and scope."
            : "")
        : status === "related_text_found"
          ? `${aspect}: related wording was found in inspected sources — ` +
            "the director should confirm interpretation and scope (nothing is finalized automatically)."
          : `${aspect}: no related wording was found ` +
            "within the inspected sources.";
    open_questions.push({
      kind,
      note,
      status,
      related,
      uninspected,
      sources,
    });
  };

  // posture tension — kept per scope; BOTH sides are cited
  const posturePieceSources = context
    .filter((s) => POSTURE_RE.test(s.content))
    .flatMap((s) => s.sources);
  if (posturePieceSources.length > 0 && POSTURE_RE.test(rev.content)) {
    open_questions.push({
      kind: "posture_scope",
      note:
        "Piece-level posture wording may differ from this scene's action/posture wording. " +
        "Confirm which posture to adopt for this scene (nothing is chosen automatically).",
      status: uninspected_sources.length
        ? "not_inspected"
        : "related_text_found",
      related: [
        // the scene's own posture wording AND the piece-level lines
        ...relatedTo(POSTURE_RE),
      ],
      uninspected: uninspected_sources,
      sources: [...posturePieceSources, docSrc],
    });
  }

  pushQuestion("style", "Visual style", STYLE_RE);
  pushQuestion("color", "Color", COLOR_RE);
  pushQuestion("main_subject", "Main subject count", MAIN_SUBJECT_RE);
  pushQuestion(
    "background_people",
    "Background people (separate from main-subject count)",
    BACKGROUND_PEOPLE_RE,
  );
  pushQuestion("composition", "Composition / camera", COMPOSITION_RE);
  pushQuestion(
    "negative_policy",
    "Negative-prompt policy (nothing is auto-added)",
    NEGATIVE_RE,
  );

  return {
    status: "preview",
    project_id: args.project_id,
    blueprint_version_id: bv.id,
    blueprint_version_no: bv.version_no,
    document_id: doc.id,
    document_revision_id: rev.id,
    document_rev_no: rev.rev_no,
    scene,
    constraints,
    context,
    unclassified,
    open_questions,
    unresolved_sources,
    uninspected_sources,
    ref_assets,
  };
}

/** Build exactly what the preview endpoint displays and bind the entire
 * target plus payload to a stable digest. */
export function buildSceneDraftPreview(
  db: DatabaseSync,
  args: {
    project_id: string;
    blueprint_version_id: string;
    document_revision_id: string;
  },
): SceneInputDraft {
  const draft = buildSceneDraft(db, args);
  const payload = {
    ...draft,
    payload_version: SCENE_DRAFT_PAYLOAD_VERSION,
    builder_version: SCENE_DRAFT_BUILDER_VERSION,
  } as Omit<SceneInputDraft, "digest">;
  return { ...payload, digest: sceneDraftDigest(payload) };
}

/** Rebuild and save inside one short SQLite transaction. Only target
 * IDs and the preview digest are accepted from the client; source text,
 * provenance, and statuses always come from the server builder. */
export function saveVerifiedSceneInputDraft(
  db: DatabaseSync,
  input: {
    project_id: string;
    blueprint_version_id: string;
    document_id: string;
    document_revision_id: string;
    digest: string;
  },
): SceneInputDraftRecord {
  return transact(db, () => {
    const target = validateSceneInputDraftTarget(db, input);
    if (target.adopted_revision_id !== input.document_revision_id) {
      throw new ConflictError(
        "the adopted document revision changed after preview; review the current preview again",
      );
    }
    const preview = buildSceneDraftPreview(db, input);
    if (preview.document_id !== input.document_id || preview.digest !== input.digest) {
      throw new ConflictError(
        "the preview content or inspection status changed; review the preview again",
      );
    }
    return insertSceneInputDraft(db, {
      ...input,
      payload_version: SCENE_DRAFT_PAYLOAD_VERSION,
      builder_version: SCENE_DRAFT_BUILDER_VERSION,
      snapshot: preview,
    });
  });
}
