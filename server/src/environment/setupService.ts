import { resolve } from "node:path";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { EnvironmentPlan, SetupRun } from "@vo/shared";
import { BadRequestError } from "../repos/errors.ts";

export const COMFY_REVISION = "b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c";
export function environmentPlanToken(plan: EnvironmentPlan): string {
  return createHash("sha256").update(JSON.stringify([plan.mode, plan.root, plan.shared_models, plan.comfy_url, plan.proxy_url, plan.source, plan.revision, plan.dependency_lock_sha256])).digest("hex");
}
function endpointOrigin(value: string | undefined, fallback: string): string {
  try { return new URL(value ?? fallback).origin; } catch { return fallback; }
}
export function planEnvironment(mode: unknown, repoRoot = resolve(import.meta.dirname, "../../..")): EnvironmentPlan {
  if (mode !== "existing" && mode !== "managed") throw new BadRequestError("mode must be existing or managed");
  let available_bytes: number | undefined;
  try { const disk = statfsSync(repoRoot); available_bytes = disk.bavail * disk.bsize; } catch { /* Explicitly unavailable on unsupported filesystems. */ }
  const plan: EnvironmentPlan = {
    mode, root: mode === "managed" ? resolve(repoRoot, "runtime") : "External environment (not managed by VO)", shared_models: resolve(repoRoot, "../../models"),
    comfy_url: mode === "existing" ? endpointOrigin(process.env.COMFY_DISCOVERY_URL, "http://127.0.0.1:8288") : "http://127.0.0.1:8288",
    proxy_url: mode === "existing" ? endpointOrigin(process.env.COMFY_BASE_URL, "http://127.0.0.1:8289") : "http://127.0.0.1:8289",
    source: "https://github.com/Comfy-Org/ComfyUI.git", revision: COMFY_REVISION,
    installed: existsSync(resolve(repoRoot, "runtime/comfyui/main.py")) && existsSync(resolve(repoRoot, "runtime/venv/Scripts/python.exe")),
    dependency_lock_sha256: existsSync(resolve(repoRoot, "scripts/comfy-requirements.lock.txt")) ? createHash("sha256").update(readFileSync(resolve(repoRoot, "scripts/comfy-requirements.lock.txt"))).digest("hex") : undefined,
    required_bytes: mode === "managed" ? 12 * 1024 ** 3 : 0, available_bytes, capacity_status: "estimate",
    dependencies: mode === "managed" ? ["Git", "uv", "Python 3.13", "ComfyUI requirements (locked)", "CUDA PyTorch", "comfy-api-proxy (official)", "No third-party custom nodes"] : [],
    steps: mode === "managed" ? [
      { id: "source", description: "Clone pinned upstream into runtime/comfyui; preserve existing environments" },
      { id: "venv", description: "Create isolated runtime/venv and install locked dependencies" },
      { id: "models", description: "Reference shared model directories; never copy or download weights" },
      { id: "workflows", description: "Copy template workflows into managed user root without replacing originals" },
      { id: "services", description: "Start or resume owned loopback services without replacing another listener" },
      { id: "connect", description: "Verify node catalog and SDK proxy; connect only when generation is idle" },
    ] : [{ id: "connect", description: "Inspect selected existing endpoint; never update its packages or restart it" }],
  };
  return { ...plan, plan_token: environmentPlanToken(plan) };
}

/** Installer and UI share the plan. Real execution is the explicit local setup command. */
export function executeSetupFixture(plan: EnvironmentPlan, failAt?: string, completed: string[] = []): SetupRun {
  const done = plan.steps.filter((s) => completed.includes(s.id)).map((s) => s.id);
  for (const step of plan.steps) {
    if (done.includes(step.id)) continue;
    if (step.id === failAt) return { plan, mock: true, status: "failed", completed_steps: done, error: `MOCK failure: ${step.id}` };
    done.push(step.id);
  }
  return { plan, mock: true, status: "mock_completed", completed_steps: done };
}
