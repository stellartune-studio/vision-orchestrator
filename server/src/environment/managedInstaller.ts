import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvironmentPlan } from "@vo/shared";
import { ConflictError } from "../repos/errors.ts";
import { executeExistingEnvironment, readLocalJson } from "./executeExisting.ts";
import { runInstallSteps, type InstallJournal, type InstallStep } from "./installRunner.ts";

export function installCommand(file: string, args: string[], recordChild: (pid: number | undefined) => void = () => {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      recordChild(undefined);
      if (error) reject(new Error(`${file} failed: ${(stderr || error.message).slice(-2000)}`));
      else resolve(stdout);
    });
    recordChild(child.pid);
  });
}
async function serviceReady(plan: EnvironmentPlan): Promise<boolean> {
  try {
    const health = await readLocalJson(plan.proxy_url + "/api/v2/health");
    const stats = await readLocalJson(plan.comfy_url + "/system_stats");
    return health.status === "healthy" && health.upstream === plan.comfy_url && stats.system?.argv?.includes(resolve(plan.root, "user"));
  } catch { return false; }
}

/** Fixed trusted commands only. Network access requires explicit per-run consent. */
export async function installManagedEnvironment(args: {
  plan: EnvironmentPlan; allowDownloads: boolean; startServices: boolean;
  assertAllowed: () => void; connect: (endpoint: string) => boolean;
  repoRoot?: string;
}): Promise<InstallJournal> {
  const root = args.repoRoot ?? resolve(import.meta.dirname, "../../..");
  const plan = args.plan;
  if (plan.mode !== "managed" || plan.root !== resolve(root, "runtime")) throw new ConflictError("Installer target must be the reviewed VO-managed runtime");
  const source = resolve(plan.root, "comfyui"), python = resolve(plan.root, "venv/Scripts/python.exe");
  const psStep = async (step: string, record: (pid: number | undefined) => void) => {
    await installCommand("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", resolve(root, "scripts/setup-comfy.ps1"), "-Step", step, ...(args.allowDownloads ? ["-AllowDownloads"] : [])], record);
  };
  const stoppedStep = async (step: string, record: (pid: number | undefined) => void) => {
    try { await readLocalJson(plan.comfy_url + "/system_stats"); }
    catch { await psStep(step, record); return; }
    throw new ConflictError("Dedicated ComfyUI is running; source/dependency/config repair requires an explicit maintenance stop");
  };
  const sourceReady = async () => {
    const pending = resolve(plan.root, "source-checkout-pending.json");
    if (existsSync(pending) && JSON.parse(readFileSync(pending, "utf8").replace(/^\uFEFF/, "")).pending) return false;
    if (!existsSync(resolve(source, ".git"))) return false;
    const revision = (await installCommand("git", ["-C", source, "rev-parse", "HEAD"])).trim();
    const origin = (await installCommand("git", ["-C", source, "remote", "get-url", "origin"])).trim();
    const dirty = (await installCommand("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"])).trim();
    if (dirty || origin !== plan.source || revision !== plan.revision) throw new ConflictError("Existing source differs from the reviewed upstream; no overwrite performed");
    return true;
  };
  const dependencyReady = async () => {
    if (!existsSync(python)) return false;
    const actual = JSON.parse(await installCommand(python, ["-I", "-S", "-c", "import importlib.metadata as m,json,sys;print(json.dumps({'python':sys.version.split()[0],'packages':{d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions(path=[sys.argv[1]])}}))", resolve(plan.root, "venv/Lib/site-packages")])) as { python: string; packages: Record<string, string> };
    if (actual.python !== "3.13.17") throw new ConflictError("Existing venv uses a different Python; no replacement performed");
    const expected = new Map(readFileSync(resolve(root, "scripts/comfy-requirements.lock.txt"), "utf8").trim().split(/\r?\n/).filter((s) => s && !s.startsWith("#")).map((s) => { const [name, version] = s.split("=="); return [name.toLowerCase().replaceAll("_", "-"), version]; }));
    if (Object.keys(actual.packages).some((name) => !expected.has(name))) throw new ConflictError("Unreviewed packages are present; dependency sync was not run");
    return [...expected].every(([name, version]) => actual.packages[name] === version);
  };
  const modelsReady = async () => {
    const file = resolve(plan.root, "extra-model-paths.yaml");
    if (!existsSync(file)) return false;
    if (!readFileSync(file, "utf8").replaceAll("\\", "/").includes(plan.shared_models.replaceAll("\\", "/"))) throw new ConflictError("Existing shared model configuration differs; no overwrite performed");
    return true;
  };
  const workflowsReady = async () => {
    const user = resolve(plan.root, "user/default/workflows"), api = resolve(plan.root, "workflows-api");
    if (!existsSync(user) || !existsSync(api)) return false;
    const { readdirSync } = await import("node:fs");
    return readdirSync(user).filter((f) => f.endsWith(".json")).every((f) => existsSync(resolve(api, f)));
  };
  const steps: InstallStep[] = [
    { id: "source", ready: sourceReady, apply: (record) => stoppedStep("source", record) },
    { id: "venv", ready: dependencyReady, apply: (record) => stoppedStep("venv", record) },
    { id: "models", ready: modelsReady, apply: (record) => stoppedStep("models", record) },
    { id: "workflows", ready: workflowsReady, apply: (record) => psStep("workflows", record) },
  ];
  let verified = false; let connectionApplied = false;
  if (args.startServices) {
    steps.push({ id: "services", ready: () => serviceReady(plan), apply: async (record) => { await installCommand("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", resolve(root, "scripts/start-comfy.ps1")], record); } });
    steps.push({ id: "connect", ready: async () => verified, apply: async () => {
      const verification = await executeExistingEnvironment(plan, { expected_revision: plan.revision, expected_lock_sha256: plan.dependency_lock_sha256, expected_plan_token: plan.plan_token, assertIdle: args.assertAllowed, connect: args.connect, repoRoot: root });
      connectionApplied = verification.connection_applied === true;
      verified = true;
    } });
  }
  const file = resolve(plan.root, "setup-install-state.json");
  const result = await runInstallSteps({ plan, file, steps, assertAllowed: args.assertAllowed, startServices: args.startServices });
  result.connection_applied = connectionApplied;
  writeFileSync(file + ".final.tmp", JSON.stringify(result, null, 2)); renameSync(file + ".final.tmp", file);
  return result;
}
