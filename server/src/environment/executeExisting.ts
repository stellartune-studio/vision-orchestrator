import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvironmentPlan, SetupRun } from "@vo/shared";
import { BadRequestError, ConflictError, UnprocessableError } from "../repos/errors.ts";
import { environmentPlanToken } from "./setupService.ts";

const runFile = promisify(execFile);
export async function readLocalJson(url: string): Promise<Record<string, any>> {
  const target = new URL(url);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password) throw new BadRequestError("Connection verification requires unauthenticated loopback HTTP");
  const result = await fetch(target, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!result.ok) throw new UnprocessableError(`Connection verification returned HTTP ${result.status}`);
  return result.json();
}

/** Real reuse executor: verifies an already-installed environment, never installs or restarts. */
export async function executeExistingEnvironment(plan: EnvironmentPlan, args: {
  expected_revision: unknown;
  expected_lock_sha256: unknown;
  expected_plan_token: unknown;
  assertIdle: () => void;
  connect: (endpoint: string) => boolean;
  repoRoot?: string;
}): Promise<SetupRun> {
  if (args.expected_revision !== plan.revision || args.expected_lock_sha256 !== plan.dependency_lock_sha256 || args.expected_plan_token !== environmentPlanToken(plan)) throw new ConflictError("Setup plan changed; review it again");
  args.assertIdle();
  const repoRoot = args.repoRoot ?? resolve(import.meta.dirname, "../../..");
  const completed_steps: string[] = [];
  const evidence: Record<string, unknown> = { execution: "reuse_existing_no_install", new_nodes: [], generation_verified: false };
  const state: SetupRun = { plan, mock: false, status: "running", completed_steps, evidence };
  try {
    if (plan.mode === "managed") {
      if (!plan.installed) throw new UnprocessableError("Dedicated environment not installed; fresh installation requires the explicit local setup command");
      const source = resolve(repoRoot, "runtime/comfyui");
      const revision = (await runFile("git", ["rev-parse", "HEAD"], { cwd: source, windowsHide: true, timeout: 10_000 })).stdout.trim();
      const origin = (await runFile("git", ["remote", "get-url", "origin"], { cwd: source, windowsHide: true, timeout: 10_000 })).stdout.trim();
      if (revision !== plan.revision || origin !== plan.source) throw new UnprocessableError("Dedicated upstream identity does not match the reviewed plan");
      const modified = (await runFile("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, windowsHide: true, timeout: 10_000 })).stdout.trim();
      if (modified) throw new UnprocessableError("Dedicated upstream has unreviewed tracked source changes");
      const custom = readdirSync(resolve(source, "custom_nodes")).filter((n) => !["__pycache__", "example_node.py.example", "websocket_image_save.py"].includes(n));
      if (custom.length) throw new UnprocessableError(`Unreviewed custom nodes require explicit authorization: ${custom.join(", ")}`);
      const lock = readFileSync(resolve(repoRoot, "scripts/comfy-requirements.lock.txt"), "utf8").trim().split(/\r?\n/).filter((s) => s && !s.startsWith("#"));
      const python = resolve(repoRoot, "runtime/venv/Scripts/python.exe");
      const metadata = await runFile(python, ["-I", "-S", "-c", "import importlib.metadata as m,json,sys; print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions(path=[sys.argv[1]])}))", resolve(repoRoot, "runtime/venv/Lib/site-packages")], { windowsHide: true, timeout: 30_000 });
      const installed = JSON.parse(metadata.stdout) as Record<string, string>;
      const mismatch = lock.filter((line) => { const [name, version] = line.split("=="); return !version || installed[name.toLowerCase().replaceAll("_", "-")] !== version; });
      if (mismatch.length) throw new UnprocessableError(`Installed dependencies differ from lock: ${mismatch.join(", ")}`);
      const names = new Set(lock.map((line) => line.split("==")[0].toLowerCase().replaceAll("_", "-")));
      if (Object.keys(installed).some((name) => !names.has(name))) throw new UnprocessableError("Unreviewed packages exist outside the dependency lock");
      evidence.upstream_revision = revision; evidence.source = origin;
      evidence.dependency_lock_sha256 = plan.dependency_lock_sha256;
      evidence.locked_dependencies_verified = lock.length;
      evidence.source_worktree_clean = true;
      const pathsFile = resolve(repoRoot, "runtime/extra-model-paths.yaml");
      if (!existsSync(plan.shared_models) || !existsSync(pathsFile) || !readFileSync(pathsFile, "utf8").replaceAll("\\", "/").includes(plan.shared_models.replaceAll("\\", "/"))) throw new UnprocessableError("Shared model reference differs from the reviewed plan");
      if (!existsSync(resolve(repoRoot, "runtime/user/default/workflows")) || !existsSync(resolve(repoRoot, "runtime/workflows-api"))) throw new UnprocessableError("Editable workflow copy directories are missing");
      evidence.shared_models_reference = plan.shared_models;
      evidence.workflow_copy_directories_verified = true;
      completed_steps.push("source", "venv", "models", "workflows");
    }
    const [stats, nodes, health, queue] = await Promise.all([
      readLocalJson(plan.comfy_url + "/system_stats"), readLocalJson(plan.comfy_url + "/object_info"),
      readLocalJson(plan.proxy_url + "/api/v2/health"), readLocalJson(plan.comfy_url + "/queue"),
    ]);
    if (health.status !== "healthy" || health.upstream !== plan.comfy_url || !Object.keys(nodes).length) throw new UnprocessableError("Proxy upstream or node catalog differs from the reviewed environment");
    if (queue.queue_running?.length || queue.queue_pending?.length) throw new ConflictError("ComfyUI has active jobs; keep their original environment until they finish");
    args.assertIdle();
    state.connection_applied = args.connect(plan.proxy_url);
    evidence.comfy_version = stats.system?.comfyui_version;
    evidence.registered_nodes = Object.keys(nodes).length;
    evidence.proxy_upstream = health.upstream;
    completed_steps.push("connect");
    state.status = "connected_not_generation_verified";
  } catch (error) {
    state.status = "failed"; state.error = error instanceof Error ? error.message : String(error);
    const file = resolve(repoRoot, "runtime/setup-state.json");
    if (existsSync(resolve(repoRoot, "runtime"))) writeFileSync(file, JSON.stringify(state, null, 2));
    throw error;
  }
  const file = resolve(repoRoot, "runtime/setup-state.json");
  if (existsSync(resolve(repoRoot, "runtime"))) writeFileSync(file, JSON.stringify(state, null, 2));
  return state;
}
