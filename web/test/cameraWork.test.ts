import test from "node:test";
import assert from "node:assert/strict";
import type { GenerationRecord } from "@vo/shared";
import { cameraWorkStateOf } from "../src/features/cameraWork.ts";

function rec(
  kind: GenerationRecord["kind"],
  refs: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): GenerationRecord {
  return {
    id: "g1",
    project_id: "p1",
    kind,
    status: "succeeded",
    backend: "comfy-sdk",
    backend_job_id: null,
    blueprint_version_id: "bv1",
    document_revision_id: "d1",
    inputs: JSON.stringify({
      kind,
      prompt: "p",
      ref_images: [],
      settings,
      resolved_refs: refs,
    }),
    output_asset_id: null,
    error: null,
    created_at: "2026-10-21",
    updated_at: "2026-10-21",
  };
}

const ADOPTED = ["rev-cw-1"];

test("no camera_work item in the version → no badge", () => {
  assert.equal(
    cameraWorkStateOf(rec("video", { camera_work_revision_ids: [] })),
    null,
  );
});

test("adopted and applied on the verified path → applied", () => {
  assert.equal(
    cameraWorkStateOf(
      rec("video", {
        camera_work_revision_ids: ADOPTED,
        camera_work_applied_revision_ids: ADOPTED,
        camera_work_verified_graph_sha256: "abc",
      }),
    ),
    "applied",
  );
});

test("adopted but generation is an image → notAppliedKind", () => {
  assert.equal(
    cameraWorkStateOf(
      rec("image", { camera_work_revision_ids: ADOPTED }),
    ),
    "notAppliedKind",
  );
});

test("adopted + verbatim selection → notAppliedVerbatim", () => {
  assert.equal(
    cameraWorkStateOf(
      rec(
        "video",
        { camera_work_revision_ids: ADOPTED },
        { workflow_selection: { prompt_verbatim: true } },
      ),
    ),
    "notAppliedVerbatim",
  );
});

test("adopted + other workflow → notAppliedWorkflow", () => {
  assert.equal(
    cameraWorkStateOf(
      rec(
        "video",
        { camera_work_revision_ids: ADOPTED },
        { workflow_selection: { name: "custom" } },
      ),
    ),
    "notAppliedWorkflow",
  );
  // no saved selection with applied=0 is also a non-verified state
  assert.equal(
    cameraWorkStateOf(
      rec("video", { camera_work_revision_ids: ADOPTED }),
    ),
    "notAppliedWorkflow",
  );
});
