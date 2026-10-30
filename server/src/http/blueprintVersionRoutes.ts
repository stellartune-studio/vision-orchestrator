import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db/connection.ts";
import {
  createBlueprintVersion,
  getBlueprintVersionDetail,
  listBlueprintVersions,
} from "../repos/blueprints.ts";
import { sendJson, type Router } from "./router.ts";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

export function registerBlueprintVersionRoutes(
  r: Router,
  db: DatabaseSync,
): void {
  r.get("/api/projects/:id/blueprint-versions", (c) =>
    sendJson(c.res, 200, listBlueprintVersions(db, c.params.id)),
  );

  r.post("/api/projects/:id/blueprint-versions", (c) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const bv = transact(db, () =>
      createBlueprintVersion(db, c.params.id, str(b.note)),
    );
    sendJson(c.res, 201, bv);
  });

  r.get("/api/blueprint-versions/:id", (c) =>
    sendJson(c.res, 200, getBlueprintVersionDetail(db, c.params.id)),
  );
}
