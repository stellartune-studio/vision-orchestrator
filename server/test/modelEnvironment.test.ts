import { bundledWorkflowCatalog } from "../src/gen/workflowCatalog.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { WorkflowSelection } from "@vo/shared";
import { openDatabase, transact } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { createProject } from "../src/repos/projects.ts";
import { getGenerationSelection, saveGenerationSelection } from "../src/repos/generationSelection.ts";
import { parseWorkflowSelection } from "../src/gen/workflowSelection.ts";
import { ComfySdkBackend } from "../src/gen/comfySdkBackend.ts";
import type { GenerationInput } from "../src/gen/backend.ts";
import { executeSetupFixture, environmentPlanToken, planEnvironment } from "../src/environment/setupService.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildRouter } from "../src/http/handlers.ts";
import { MockDirectorProvider } from "../src/llm/mockProvider.ts";
import type { ServerConfig } from "../src/config.ts";
import { workflowCatalogIssues } from "../src/gen/catalogValidation.ts";
import { executeExistingEnvironment } from "../src/environment/executeExisting.ts";
import { beginSetupOperation, hasGenerationRequests, withGenerationRequest } from "../src/gen/activity.ts";
import type { GenerationBackend } from "../src/gen/backend.ts";

const selection: WorkflowSelection = {
  name: "user-edited-video.json", kind: "video",
  graph: {
    "model": { class_type: "AnyModelLoader", inputs: { model_file: "original.gguf" } },
    "lora": { class_type: "AnyLoraLoader", inputs: { model: ["model", 0], lora_name: "original.safetensors", strength: 0.5 } },
    "encoder": { class_type: "CustomEncoder", inputs: { encoder_name: "original-encoder.bin", prompt: "placeholder" } },
    "sample": { class_type: "AnyVideoSampler", inputs: { model: ["lora", 0], width: 512, seed: 123 } },
    "out": { class_type: "SaveVideo", inputs: { video: ["sample", 0] } },
  },
  prompt: { node: "encoder", input: "prompt" }, output_node: "out",
  settings: { width: { node: "sample", input: "width", scale: 0.5 } },
  values: [{ node: "model", input: "model_file", value: "selected.gguf" }, { node: "lora", input: "lora_name", value: "chosen.safetensors" }, { node: "encoder", input: "encoder_name", value: "chosen-encoder.bin" }],
};

test("user workflow main/component/LoRA edits reach SDK without mutating source; generic T2V needs no image", async () => {
  let submitted: any;
  const edits: any[] = [];
  const client = {
    workflows: { fromJson: (graph: unknown) => { submitted = graph; return { setInput: (...args: unknown[]) => edits.push(args) }; } },
    submit: async () => ({ id: "sdk-fixture-job" }),
  };
  const backend = new ComfySdkBackend({ base: { file: "unused", prompt_node: "unused", output_node: "unused" }, video: { file: "unused", prompt_node: "unused", output_node: "unused" } }, ".", async () => client as any);
  const input: GenerationInput = {
    kind: "video", prompt: "approved content only", ref_images: [], settings: { width: 1280, workflow_selection: parseWorkflowSelection(selection) },
    resolved_refs: { blueprint_version_id: "b", item_revision_ids: [], character_revision_ids: [], base_image_asset_ids: [], ref_image_asset_ids: [], asset_ids: [], used_asset_ids: [] },
  };
  assert.equal(backend.describe(input).profile_id, "user-workflow");
  assert.equal((await backend.submit(input, { project_id: "p", generation_id: "g" })).backend_job_id, "sdk-fixture-job");
  assert.equal(submitted.model.inputs.model_file, "selected.gguf");
  assert.equal(submitted.lora.inputs.lora_name, "chosen.safetensors");
  assert.equal(submitted.encoder.inputs.encoder_name, "chosen-encoder.bin");
  assert.equal(submitted.sample.inputs.width, 640);
  assert.deepEqual(edits, [["encoder", "prompt", "approved content only"]]);
  assert.equal(selection.graph.model.inputs.model_file, "original.gguf");
});

test("workflow validation rejects dropped inputs, graph-link replacement and reserved prompt overrides", () => {
  assert.throws(() => parseWorkflowSelection({ ...selection, values: [{ node: "missing", input: "x", value: "x" }] }));
  assert.throws(() => parseWorkflowSelection({ ...selection, values: [{ node: "lora", input: "model", value: "x" }] }));
  assert.throws(() => parseWorkflowSelection({ ...selection, values: [{ node: "encoder", input: "prompt", value: "unapproved" }] }));
  assert.throws(() => parseWorkflowSelection({ ...selection, values: [{ node: "lora", input: "strength", value: "wrong type" }] }));
});

test("selection persists separately from adoption; stale save and cross-project access fail", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db, join(import.meta.dirname, "../src/db/migrations"));
    const p = createProject(db, "settings fixture");
    assert.deepEqual(getGenerationSelection(db, p.id), { version: 0, selection: null });
    const saved = transact(db, () => saveGenerationSelection(db, p.id, 0, selection));
    assert.deepEqual(saved.selection, selection);
    assert.throws(() => transact(db, () => saveGenerationSelection(db, p.id, 0, null)), /changed/);
    assert.equal(getGenerationSelection(db, p.id).version, 1);
    assert.throws(() => getGenerationSelection(db, "missing"));
    assert.equal(transact(db, () => saveGenerationSelection(db, p.id, 1, null)).version, 2);
  } finally { db.close(); }
});

test("setup plan is reusable and failed fixture resumes without claiming real completion", () => {
  const plan = planEnvironment("managed");
  assert.match(plan.root, /runtime$/);
  assert.ok(plan.required_bytes > 0);
  const failed = executeSetupFixture(plan, "venv");
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.completed_steps, ["source"]);
  const resumed = executeSetupFixture(plan, undefined, failed.completed_steps);
  assert.equal(resumed.status, "mock_completed");
  assert.equal(resumed.mock, true);
  assert.equal(resumed.completed_steps.length, plan.steps.length);
  assert.equal(planEnvironment("existing").required_bytes, 0);
  const previous = process.env.COMFY_BASE_URL;
  try {
    process.env.COMFY_BASE_URL = "http://fixture-user:fixture-secret@127.0.0.1:8189/private?token=fixture";
    assert.equal(planEnvironment("existing").proxy_url, "http://127.0.0.1:8189");
  } finally {
    if (previous === undefined) delete process.env.COMFY_BASE_URL;
    else process.env.COMFY_BASE_URL = previous;
  }
  assert.throws(() => planEnvironment("unknown"));
});

test("HTTP selection save/resume reaches the generation snapshot; stale selection is rejected", async () => {
  const db = openDatabase(":memory:");
  migrate(db, join(import.meta.dirname, "../src/db/migrations"));
  const submissions: GenerationInput[] = [];
  let connection = "http://127.0.0.1:8289";
  const config: ServerConfig = { port: 0, data_dir: ".", db_path: ":memory:", assets_root: ".", llm_provider: "mock", gen_backend: "mock", workflow_file: "unused", max_body_bytes: 1024 * 1024 };
  const router = buildRouter({ db, config, llm: new MockDirectorProvider(), gen: {
    name: "fixture", isMock: true, capabilities: { kinds: ["image", "video"], ref_image: true },
    describe: () => ({ connection_origin: connection }),
    async submit(input) { submissions.push(input); return { backend_job_id: "fixture-job" }; },
    async poll() { return { status: "running" }; },
  } });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const p = (await api("POST", "/api/projects", { name: "workflow HTTP fixture" })).body;
    const state = (await api("GET", `/api/projects/${p.id}/state`)).body;
    for (const kind of ["intent", "output_policy"]) {
      const item = state.items.find((i: any) => i.kind === kind);
      const rev = (await api("POST", `/api/items/${item.id}/revisions`, { content: kind === "intent" ? "approved intent" : "16:9" })).body;
      assert.equal((await api("POST", `/api/items/${item.id}/adopt`, { revision_id: rev.id, expected_version: item.state_version })).status, 200);
    }
    const bv = (await api("POST", `/api/projects/${p.id}/blueprint-versions`, {})).body;
    const doc = (await api("POST", `/api/projects/${p.id}/documents`, { kind: "script", blueprint_version_id: bv.id })).body;
    await api("POST", `/api/documents/${doc.document.id}/adopt`, { revision_id: doc.revision.id, expected_version: doc.document.state_version });
    const selected = structuredClone(selection);
    selected.settings!.height = { node: "sample", input: "height" };
    selected.graph.sample.inputs.height = 512;
    selected.settings!.seed = { node: "sample", input: "seed" };
    const path = `/api/projects/${p.id}/generation-selection`;
    assert.equal((await api("PUT", path, { expected_version: 0, selection: selected })).status, 200);
    assert.equal((await api("GET", path)).body.selection.values[0].value, "selected.gguf");
    assert.equal((await api("PUT", path, { expected_version: 0, selection: null })).status, 409);
    const request = { blueprint_version_id: bv.id, document_revision_id: doc.revision.id, kind: "video" };
    assert.equal((await api("POST", `/api/projects/${p.id}/generations`, { ...request, selection_version: 0 })).status, 409);
    const generated = await api("POST", `/api/projects/${p.id}/generations`, { ...request, selection_version: 1 });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.deepEqual(submissions[0].settings.workflow_selection, selected);
    assert.equal(submissions[0].settings.seed, undefined, "generic graphs retain their literal seed, never builder seed 42");
    assert.deepEqual(JSON.parse(generated.body.inputs).settings.workflow_selection, selected);
    assert.equal(submissions.length, 1);
    const plan = (await api("POST", "/api/environment/plan", { mode: "managed" })).body;
    const blocked = await api("POST", "/api/environment/execute", { mode: "managed", expected_revision: plan.revision, expected_lock_sha256: plan.dependency_lock_sha256, expected_plan_token: plan.plan_token });
    assert.equal(blocked.status, 409); assert.match(blocked.body.error, /active/);
    connection = "http://127.0.0.1:9999";
    assert.equal((await api("GET", `/api/generations/${generated.body.id}`)).status, 409);
    assert.equal((await api("GET", `/api/projects/${p.id}/state`)).body.generations[0].status, "running");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
});

test("catalog mismatch reports stale model/LoRA choices without substituting them", () => {
  const catalog = {
    AnyModelLoader: { input: { required: { model_file: [["selected.gguf"]] } } },
    AnyLoraLoader: { input: { required: { lora_name: ["COMBO", { options: ["other.safetensors"] }], strength: ["FLOAT", { min: 0, max: 1 }] } } },
    CustomEncoder: {}, AnyVideoSampler: {}, SaveVideo: {},
  };
  assert.deepEqual(workflowCatalogIssues(selection, catalog), ["lora.lora_name: selected value is unavailable: chosen.safetensors"]);
  assert.equal(selection.values[1].value, "chosen.safetensors");
  Object.assign(catalog.AnyVideoSampler, { output: ["MODEL"] });
  Object.assign(catalog.SaveVideo, { input: { required: { video: ["IMAGE"] } } });
  assert.ok(workflowCatalogIssues(selection, catalog).some((issue) => issue.includes("incompatible link MODEL → IMAGE")));
  const referenceGraph = structuredClone(selection);
  referenceGraph.graph.ref = { class_type: "LoadImage", inputs: { image: "template-placeholder.png" } };
  referenceGraph.reference = { node: "ref", input: "image" };
  Object.assign(catalog, { LoadImage: { input: { required: { image: [["uploaded-asset.png"]] } } } });
  assert.ok(workflowCatalogIssues(referenceGraph, catalog).some((issue) => issue.includes("template-placeholder")));
  assert.ok(!workflowCatalogIssues(referenceGraph, catalog, undefined, true).some((issue) => issue.includes("template-placeholder")));
});

test("real reuse executor reaches verification/connect and refuses an active remote queue", async () => {
  let active = false;
  const service = createServer((req, res) => {
    const data = req.url === "/api/v2/health" ? { status: "healthy", upstream: base }
      : req.url === "/queue" ? { queue_running: active ? [["owned-job"]] : [], queue_pending: [] }
      : req.url === "/object_info" ? { Fixture: {} } : { system: { comfyui_version: "fixture" } };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data));
  });
  let base = "";
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const plan = { ...planEnvironment("existing"), comfy_url: base, proxy_url: base };
  let connects = 0;
  try {
    const args = { expected_revision: plan.revision, expected_lock_sha256: plan.dependency_lock_sha256, expected_plan_token: environmentPlanToken(plan), assertIdle() {}, connect() { connects++; return true; }, repoRoot: join(import.meta.dirname, "no-runtime-fixture") };
    const result = await executeExistingEnvironment(plan, args);
    assert.equal(result.mock, false); assert.equal(result.connection_applied, true);
    assert.equal(result.evidence?.execution, "reuse_existing_no_install");
    active = true;
    await assert.rejects(() => executeExistingEnvironment(plan, args), /active jobs/);
    assert.equal(connects, 1);
    await assert.rejects(() => executeExistingEnvironment(plan, { ...args, expected_revision: "stale" }), /plan changed/);
    const missing = { ...plan, mode: "managed" as const, installed: false };
    await assert.rejects(() => executeExistingEnvironment(missing, { ...args, expected_plan_token: environmentPlanToken(missing) }), /not installed/);
    await assert.rejects(() => executeExistingEnvironment({ ...plan, proxy_url: "http://127.0.0.1:9999" }, args), /plan changed/);
  } finally { await new Promise<void>((resolve) => service.close(() => resolve())); }
});

test("connection guard sees preflight requests before a DB job exists and releases on failure", async () => {
  const backend = {} as GenerationBackend;
  await assert.rejects(() => withGenerationRequest(backend, async () => {
    assert.equal(hasGenerationRequests(backend), true);
    await Promise.resolve();
    assert.equal(hasGenerationRequests(backend), true);
    throw new Error("preflight fixture failure");
  }), /fixture failure/);
  assert.equal(hasGenerationRequests(backend), false);
});


test("setup lease rejects generation preflight and overlapping setup", async () => {
  const backend = {} as GenerationBackend;
  const release = beginSetupOperation(backend);
  try {
    assert.throws(() => beginSetupOperation(backend), /active/);
    await assert.rejects(withGenerationRequest(backend, async () => "must not run"), /installation is active/);
  } finally { release(); }
  assert.equal(await withGenerationRequest(backend, async () => "resumed"), "resumed");
});


test("dynamic combo accepts official option keys and validates selected nested controls", () => {
 const s = structuredClone(selection);
 s.graph.sample.inputs.sampling_mode = "on"; s.graph.sample.inputs["sampling_mode.temperature"] = 0.7;
 const catalog: Record<string, any> = Object.fromEntries(Object.values(s.graph).map((n) => [String(n.class_type), {}]));
 catalog.AnyVideoSampler = { input: { required: { sampling_mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "on", inputs: { required: { temperature: ["FLOAT", { min: 0.01, max: 2 }] } } }, { key: "off", inputs: { required: {} } }] }] } } };
 assert.deepEqual(workflowCatalogIssues(s, catalog), []);
 s.graph.sample.inputs["sampling_mode.temperature"] = 3;
 assert.match(workflowCatalogIssues(s, catalog).join(), /outside registered limits/);
});


test("pinned official MOSS is distributable with source and exact reproduction bindings", () => {
 const entry = bundledWorkflowCatalog()[0];
 assert.match(entry.name, /Official MOSS.*46e060ea/);
 const parsed = parseWorkflowSelection(entry.selection);
 assert.equal(parsed.prompt_verbatim, true);
 assert.deepEqual(parsed.prompt, { node: "18_17", input: "value" });
 assert.equal(parsed.source?.revision, "46e060ea88eb07adecf07197ec384c54a70e030c");
 assert.equal(parsed.graph["18_7"].inputs.steps, 25);
 assert.deepEqual(parsed.values, []);
 const db = openDatabase(":memory:"); migrate(db, join(import.meta.dirname, "../src/db/migrations"));
 try {
  const project = transact(db, () => createProject(db, "catalog fixture"));
  const saved = transact(db, () => saveGenerationSelection(db, project.id, 0, parsed));
  assert.deepEqual(saved.selection?.source, parsed.source);
  assert.equal(getGenerationSelection(db, project.id).selection?.prompt_verbatim, true);
 } finally { db.close(); }
});
