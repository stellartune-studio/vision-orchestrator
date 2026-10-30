/** User-owned execution settings; saving never approves content or runs a model. */
export type WorkflowValue = string | number | boolean;
/** Provider-neutral node payload. Adapters decode their own class/metadata/link formats. */
export interface WorkflowNode {
  inputs: Record<string, unknown>;
  [attribute: string]: unknown;
}
export interface WorkflowSource {
  url: string;
  revision: string;
  source_sha256: string;
  api_sha256: string;
}
export interface WorkflowCatalogEntry {
  name: string;
  graph: Record<string, WorkflowNode> | null;
  selection?: WorkflowSelection;
}
export interface WorkflowSelection {
  source?: WorkflowSource;
  name: string;
  kind: "image" | "video";
  graph: Record<string, WorkflowNode>;
  prompt: { node: string; input: string };
  /** Explicit reproduction mode: approved document must exactly equal the workflow prompt literal. */
  prompt_verbatim?: boolean;
  output_node: string;
  reference?: { node: string; input: string };
  settings?: Partial<Record<"width" | "height" | "seed" | "duration_seconds", { node: string; input: string; scale?: number }>>;
  /** Explicit input edits, including main/component models, LoRA and custom inputs. */
  values: Array<{ node: string; input: string; value: WorkflowValue }>;
}
export interface SavedWorkflowSelection {
  version: number;
  selection: WorkflowSelection | null;
}
export interface EnvironmentPlan {
  mode: "existing" | "managed";
  root: string;
  shared_models: string;
  comfy_url: string;
  proxy_url: string;
  source: string;
  revision: string;
  installed?: boolean;
  dependency_lock_sha256?: string;
  plan_token?: string;
  required_bytes: number;
  available_bytes?: number;
  capacity_status: "estimate";
  dependencies: string[];
  steps: Array<{ id: string; description: string }>;
}
/** Discovery data is opaque; provider schemas stay in the adapter, outside shared. */
export interface EnvironmentCatalog {
  connected: boolean;
  url: string;
  nodes: Record<string, unknown>;
  error?: string;
}
export interface SetupRun {
  status: "planned" | "running" | "interrupted" | "installed_not_connected" | "connected_not_generation_verified" | "mock_completed" | "failed";
  mock: boolean;
  completed_steps: string[];
  error?: string;
  plan: EnvironmentPlan;
  connection_applied?: boolean;
  evidence?: Record<string, unknown>;
  current_step?: string;
  attempts?: number;
}
