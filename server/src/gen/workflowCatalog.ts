import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { WorkflowCatalogEntry } from "@vo/shared";
import { parseWorkflowSelection } from "./workflowSelection.ts";

/** Reviewed distributable copies, separate from editable managed/user workflows. */
export function bundledWorkflowCatalog(): WorkflowCatalogEntry[] {
  const selection = parseWorkflowSelection(JSON.parse(readFileSync(resolve(import.meta.dirname, "workflows/catalog/official-moss-base-46e060ea.json"), "utf8")));
  if (createHash("sha256").update(JSON.stringify(selection.graph)).digest("hex") !== selection.source?.api_sha256) throw new Error("Bundled workflow digest mismatch");
  return [{ name: selection.name, graph: selection.graph, selection }];
}
