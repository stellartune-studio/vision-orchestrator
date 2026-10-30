import { DatabaseSync } from "node:sqlite";
import type {
  CharacterView,
  DocumentView,
  ProductionDocument,
  ProjectState,
} from "@vo/shared";
import { documentConsistency } from "../domain/state.ts";
import { listItemViews } from "./items.ts";
import { listMessages } from "./messages.ts";
import {
  currentSignature,
  listBlueprintVersions,
  snapshotSignature,
} from "./blueprints.ts";
import {
  listDocumentRevisions,
  toDocumentView,
} from "./documents.ts";
import {
  listCharacters,
  listProjectCharacters,
  toCharacterView,
} from "./characters.ts";
import { listProjectAssets } from "./assets.ts";
import { listGenerations } from "./generations.ts";
import { listAmendmentOutcomes } from "./outcomes.ts";
import { listSceneInputDrafts } from "./sceneInputDrafts.ts";
import { getProject } from "./projects.ts";
import { getWorkbenchBackground } from "./workbench.ts";

/** Full project state for resume: everything the client renders. */
export function getProjectState(
  db: DatabaseSync,
  projectId: string,
): ProjectState {
  const project = getProject(db, projectId);
  const items = listItemViews(db, projectId);
  const current = currentSignature(db, projectId);
  const snapshotCache = new Map<string, string>();

  const docs = db
    .prepare(
      `SELECT id, project_id, kind, title, adopted_revision_id,
              state_version, created_at
         FROM production_documents WHERE project_id = ? ORDER BY created_at`,
    )
    .all(projectId) as unknown as ProductionDocument[];

  const documents: DocumentView[] = docs.map((doc) => {
    const revisions = listDocumentRevisions(db, doc.id);
    const adopted = revisions.find((r) => r.id === doc.adopted_revision_id);
    let consistency: DocumentView["consistency"] = "in_sync";
    if (adopted?.blueprint_version_id) {
      let snap = snapshotCache.get(adopted.blueprint_version_id);
      if (!snap) {
        snap = snapshotSignature(db, adopted.blueprint_version_id);
        snapshotCache.set(adopted.blueprint_version_id, snap);
      }
      consistency = documentConsistency(adopted, snap, current);
    }
    return toDocumentView(doc, revisions, consistency);
  });

  const characters = listProjectCharacters(db, projectId);
  const character_views: CharacterView[] = characters.map((pc) =>
    toCharacterView(
      db,
      listCharacters(db).find((c) => c.id === pc.character_id)!,
    ),
  );

  return {
    project,
    items,
    messages: listMessages(db, projectId),
    blueprint_versions: listBlueprintVersions(db, projectId),
    documents,
    characters,
    character_views,
    assets: listProjectAssets(db, projectId),
    generations: listGenerations(db, projectId),
    amendment_outcomes: listAmendmentOutcomes(db, projectId),
    scene_input_drafts: listSceneInputDrafts(db, projectId),
    workbench_background: getWorkbenchBackground(db, projectId),
  };
}
