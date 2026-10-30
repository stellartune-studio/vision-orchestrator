import type { GenerationBackend } from "./backend.ts";
import { ConflictError } from "../repos/errors.ts";

const requests = new WeakMap<GenerationBackend, number>();
const setup = new WeakSet<GenerationBackend>();
export const hasSetupOperation = (backend: GenerationBackend): boolean => setup.has(backend);
export function beginSetupOperation(backend: GenerationBackend): () => void {
  if (setup.has(backend) || hasGenerationRequests(backend)) throw new ConflictError("Another setup or generation operation is active");
  setup.add(backend); return () => { setup.delete(backend); };
}
export function hasGenerationRequests(backend: GenerationBackend): boolean {
  return (requests.get(backend) ?? 0) > 0;
}
/** Covers async preflight before a queued record exists, as well as submission. */
export async function withGenerationRequest<T>(backend: GenerationBackend, action: () => Promise<T>): Promise<T> {
  if (setup.has(backend)) throw new ConflictError("Environment installation is active; generation is blocked until it finishes");
  requests.set(backend, (requests.get(backend) ?? 0) + 1);
  try { return await action(); }
  finally { requests.set(backend, Math.max(0, (requests.get(backend) ?? 1) - 1)); }
}
