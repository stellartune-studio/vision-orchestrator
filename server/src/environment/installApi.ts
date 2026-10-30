import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { GenerationBackend } from "../gen/backend.ts";
import { beginSetupOperation, hasGenerationRequests, hasSetupOperation } from "../gen/activity.ts";
import { hasActiveGenerations } from "../repos/generations.ts";
import { BadRequestError, ConflictError } from "../repos/errors.ts";
import { environmentPlanToken, planEnvironment } from "./setupService.ts";
import { installManagedEnvironment } from "./managedInstaller.ts";
import { assertInstallCanResume, installStatus, readInstallJournal } from "./installRunner.ts";
import { readLocalJson } from "./executeExisting.ts";
import { sendJson, type Router } from "../http/router.ts";

export function registerInstallRoutes(router: Router, db: DatabaseSync, gen: GenerationBackend): void {
  const file = resolve(import.meta.dirname, "../../../runtime/setup-install-state.json");
  router.get("/api/environment/install-state", (c) => sendJson(c.res, 200, installStatus(file, hasSetupOperation(gen))));
  router.post("/api/environment/install", async (c) => {
    const body = c.body as Record<string, unknown>;
    if (!body || body.confirm_install !== true || typeof body.allow_downloads !== "boolean") throw new BadRequestError("Reviewed install confirmation and explicit download preference required");
    const plan = planEnvironment("managed");
    const assertAllowed = () => {
      if (body.expected_plan_token !== environmentPlanToken(planEnvironment("managed"))) throw new ConflictError("Installation plan changed; review it again");
      if (hasActiveGenerations(db) || hasGenerationRequests(gen)) throw new ConflictError("Generation is active; installation cannot begin or resume");
    };
    assertAllowed();
    assertInstallCanResume(file, plan);
    // A missing endpoint is normal before first installation. An active reachable queue is not.
    let queue: Record<string, any> | undefined;
    try { queue = await readLocalJson(plan.comfy_url + "/queue"); } catch { /* cold install */ }
    if (queue?.queue_running?.length || queue?.queue_pending?.length) throw new ConflictError("Dedicated queue is active; installation is blocked");
    const release = beginSetupOperation(gen);
    const work = installManagedEnvironment({ plan, allowDownloads: body.allow_downloads, startServices: true, assertAllowed,
      connect(endpoint) { if (gen.isMock || !gen.configureConnection) return false; gen.configureConnection(endpoint); process.env.COMFY_DISCOVERY_URL = plan.comfy_url; return true; },
    });
    // The journal is saved before the first async probe. Errors remain visible in that journal.
    void work.catch(() => {}).finally(release);
    sendJson(c.res, 202, readInstallJournal(file));
  });
}
