import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDatabase, transact } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { insertRevision, adoptRevision, listItemViews } from "../src/repos/items.ts";
import { createBlueprintVersion } from "../src/repos/blueprints.ts";
import { buildGenerationInput } from "../src/gen/inputBuilder.ts";
import type { GenerationBackend, GenerationInput } from "../src/gen/backend.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vo-camerawork-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const genStub: GenerationBackend = {
  name: "stub",
  isMock: true,
  capabilities: { kinds: ["image", "video"], ref_image: true },
  describe: () => ({ profile_id: "stub" }),
  async submit(input: GenerationInput) {
    return { backend_job_id: "stub-1" };
  },
  async poll() {
    return { status: "running" };
  },
};

/** project with intent+output_policy adopted; camera_work adopted when text given */
function projectWithBlueprint(cameraText?: string, outputPolicy = "16:9 short clip") {
  const db = openDatabase(join(dir, `t${Math.random()}.db`));
  migrate(db, MIGRATIONS);
  const p = transact(db, () => createProject(db, "cw"));
  const views = listItemViews(db, p.id);
  const adopt = (kind: string, content: string) => {
    const item = views.find((v) => v.kind === kind)!;
    const rev = insertRevision(db, { item_id: item.id, content, source: "user" });
    adoptRevision(db, {
      item_id: item.id,
      revision_id: rev.id,
      expected_version: item.state_version,
    });
  };
  transact(db, () => {
    adopt("intent", "a quiet shot");
    adopt("output_policy", outputPolicy);
    if (cameraText !== undefined) adopt("camera_work", cameraText);
  });
  const bv = transact(db, () => createBlueprintVersion(db, p.id));
  return { db, projectId: p.id, blueprintVersionId: bv.id, views };
}

const args = (
  db: any,
  projectId: string,
  blueprintVersionId: string,
  kind: "image" | "video",
  camera_prompt?: boolean,
) => ({
  project_id: projectId,
  blueprint_version_id: blueprintVersionId,
  backend: genStub,
  kind,
  native_video_size: kind === "video",
  camera_prompt,
});

test("explicit output dimensions override the aspect-only video default", () => {
  const { db, projectId, blueprintVersionId } = projectWithBlueprint(undefined, "16:9 1280×720");
  const video = buildGenerationInput(db, args(db, projectId, blueprintVersionId, "video"));
  assert.deepEqual([video.settings.width, video.settings.height], [1280, 720]);
  db.close();
});

test("camera_work: adopted text reaches video prompt once; refs recorded", () => {
  const { db, projectId, blueprintVersionId } =
    projectWithBlueprint("slow push in toward the subject");
  const input = buildGenerationInput(
    db,
    args(db, projectId, blueprintVersionId, "video", true),
  );
  const lines = input.prompt.split("\n").filter((l) => l.startsWith("Camera movement:"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("slow push in toward the subject"));
  assert.equal(input.resolved_refs.camera_work_revision_ids?.length, 1);
  db.close();
});

test("aspect policy uses the native 32-pixel H3 canvas for video and preserves image size", () => {
  const { db, projectId, blueprintVersionId } = projectWithBlueprint();
  const video = buildGenerationInput(db, args(db, projectId, blueprintVersionId, "video"));
  const image = buildGenerationInput(db, args(db, projectId, blueprintVersionId, "image"));
  assert.deepEqual([video.settings.width, video.settings.height], [1344, 768]);
  assert.deepEqual([image.settings.width, image.settings.height], [1280, 720]);
  db.close();
});

test("camera_work: unspecified leaves video input untouched", () => {
  const { db, projectId, blueprintVersionId } = projectWithBlueprint();
  const input = buildGenerationInput(
    db,
    args(db, projectId, blueprintVersionId, "video", true),
  );
  assert.ok(!input.prompt.includes("Camera movement:"));
  assert.deepEqual(input.resolved_refs.camera_work_revision_ids, []);
  db.close();
});

test("camera_work: image kind never receives the line", () => {
  const { db, projectId, blueprintVersionId } =
    projectWithBlueprint("orbit around the character");
  const input = buildGenerationInput(
    db,
    args(db, projectId, blueprintVersionId, "image"),
  );
  assert.ok(!input.prompt.includes("Camera movement:"));
  // adopted revision is still recorded in provenance
  assert.equal(input.resolved_refs.camera_work_revision_ids?.length, 1);
  db.close();
});

test("camera_work: adopted after freeze does not leak into the snapshot", () => {
  const { db, projectId, blueprintVersionId, views } = projectWithBlueprint();
  // adopt camera_work AFTER the version was frozen — snapshot must not see it
  const item = views.find((v) => v.kind === "camera_work")!;
  transact(db, () => {
    const rev = insertRevision(db, {
      item_id: item.id,
      content: "late crane shot",
      source: "user",
    });
    adoptRevision(db, {
      item_id: item.id,
      revision_id: rev.id,
      expected_version: item.state_version,
    });
  });
  const input = buildGenerationInput(
    db,
    args(db, projectId, blueprintVersionId, "video", true),
  );
  assert.ok(!input.prompt.includes("Camera movement:"));
  assert.deepEqual(input.resolved_refs.camera_work_revision_ids, []);
  db.close();
});

test("camera_work: unverified video workflow leaves prompt untouched", () => {
  const { db, projectId, blueprintVersionId } =
    projectWithBlueprint("slow push in toward the subject");
  // camera_prompt absent => the effective workflow is not the verified
  // H3 path; the adopted direction must not be injected
  const input = buildGenerationInput(
    db,
    args(db, projectId, blueprintVersionId, "video"),
  );
  assert.ok(!input.prompt.includes("Camera movement:"));
  assert.equal(input.resolved_refs.camera_work_revision_ids?.length, 1);
  assert.deepEqual(input.resolved_refs.camera_work_applied_revision_ids, []);
  db.close();
});
