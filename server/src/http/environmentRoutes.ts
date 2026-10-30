import { bundledWorkflowCatalog } from "../gen/workflowCatalog.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transact } from "../db/connection.ts";
import { getGenerationSelection, saveGenerationSelection } from "../repos/generationSelection.ts";
import { parseWorkflowSelection } from "../gen/workflowSelection.ts";
import { planEnvironment, environmentPlanToken, executeSetupFixture } from "../environment/setupService.ts";
import { BadRequestError } from "../repos/errors.ts";
import { sendJson, type Router } from "./router.ts";
import type { DatabaseSync } from "node:sqlite";
import type { GenerationBackend } from "../gen/backend.ts";
import { hasActiveGenerations } from "../repos/generations.ts";
import { ConflictError } from "../repos/errors.ts";
import { executeExistingEnvironment } from "../environment/executeExisting.ts";
import { hasGenerationRequests } from "../gen/activity.ts";
import { hasSetupOperation } from "../gen/activity.ts";
import { registerInstallRoutes } from "../environment/installApi.ts";

export function registerEnvironmentRoutes(r: Router, db: DatabaseSync, gen: GenerationBackend) {
  registerInstallRoutes(r, db, gen);
  r.get("/api/projects/:id/generation-selection", (c) => sendJson(c.res, 200, getGenerationSelection(db, c.params.id)));
  r.put("/api/projects/:id/generation-selection", (c) => {
    const b = c.body as Record<string, unknown>;
    if (!b || !Number.isSafeInteger(b.expected_version) || Number(b.expected_version) < 0) throw new BadRequestError("expected_version required");
    const selection = b.selection === null ? null : parseWorkflowSelection(b.selection);
    sendJson(c.res, 200, transact(db, () => saveGenerationSelection(db, c.params.id, Number(b.expected_version), selection)));
  });
  r.get("/api/environment/workflows", (c) => {
    // Read-only shipped copies, never the user's source workflow files.
    const names = ["moss_txt2img.json", "wan22_ti2v_i2v.json", "txt2img.json", "qwen21_img2img.json", "fasth3_i2v.json"];
    const copies = resolve(import.meta.dirname, "../../../runtime/workflows-api");
    const workflows: Array<{ name: string; graph: unknown }> = names.map((name) => ({ name, graph: JSON.parse(readFileSync(resolve(import.meta.dirname, "../gen/workflows", name), "utf8")) }));
    workflows.push(...bundledWorkflowCatalog());
    if (existsSync(copies)) for (const name of readdirSync(copies).filter((n) => n.endsWith(".json")).sort().slice(0, 200)) {
      try { workflows.push({ name: `managed/${name}`, graph: JSON.parse(readFileSync(resolve(copies, name), "utf8")) }); }
      catch { workflows.push({ name: `managed/${name} (invalid JSON)`, graph: null }); }
    }
    sendJson(c.res, 200, workflows);
  });
  r.get("/api/environment/catalog", async (c) => {
    const url = new URL(process.env.COMFY_DISCOVERY_URL ?? "http://127.0.0.1:8288");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password) throw new BadRequestError("Discovery endpoint must be unauthenticated loopback HTTP");
    try {
      const response = await fetch(new URL("/object_info", url), { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nodes = await response.json();
      sendJson(c.res, 200, { connected: true, url: url.origin, nodes });
    } catch {
      sendJson(c.res, 200, { connected: false, url: url.origin, nodes: {}, error: "ComfyUI catalog unavailable; readiness is unverified" });
    }
  });
  r.post("/api/environment/plan", (c) => sendJson(c.res, 200, planEnvironment((c.body as Record<string, unknown>)?.mode)));
  r.post("/api/environment/execute", async (c) => {
    const b = c.body as Record<string, unknown>;
    const result = await executeExistingEnvironment(planEnvironment(b?.mode), {
      expected_revision: b?.expected_revision, expected_lock_sha256: b?.expected_lock_sha256,
      expected_plan_token: b?.expected_plan_token,
      assertIdle: () => {
        if (hasSetupOperation(gen)) throw new ConflictError("Managed installation is running; wait for it to finish");
        if (environmentPlanToken(planEnvironment(b.mode)) !== b.expected_plan_token) throw new ConflictError("Setup plan changed; review it again");
        if (hasActiveGenerations(db) || hasGenerationRequests(gen)) throw new ConflictError("VO has active or unresolved generation jobs; environment connection is blocked until they finish");
      },
      connect: (endpoint) => {
        if (gen.isMock || !gen.configureConnection) return false;
        gen.configureConnection(endpoint);
        process.env.COMFY_DISCOVERY_URL = planEnvironment(b.mode).comfy_url;
        return true;
      },
    });
    sendJson(c.res, 200, result);
  });
  r.get("/api/environment/setup-state", (c) => {
    const file = resolve(import.meta.dirname, "../../../runtime/setup-state.json");
    sendJson(c.res, 200, existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : null);
  });
  r.post("/api/environment/setup-fixture", (c) => {
    const b = c.body as Record<string, unknown>;
    const plan = planEnvironment(b?.mode);
    const completed = Array.isArray(b.completed_steps) ? b.completed_steps.filter((s): s is string => typeof s === "string") : [];
    sendJson(c.res, 200, executeSetupFixture(plan, typeof b.fail_at === "string" ? b.fail_at : undefined, completed));
  });
}
