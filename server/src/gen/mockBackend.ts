import { JobNotFoundError } from "./backend.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareDirUnder } from "../util/paths.ts";
import type {
  GenerationBackend,
  GenerationInput,
  GenerationJob,
  GenerationPollResult,
} from "./backend.ts";

// 1x1 transparent PNG — a stub output so the record-keeping path
// (inputs snapshot, output asset, status) can be exercised offline.
const STUB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Offline backend: submit succeeds immediately, poll reports a stub
 * image written under data/assets/<project>/. Exercises the SAME
 * record-keeping path as the real backend; the UI must show the
 * mock badge while active.
 */
export class MockGenerationBackend implements GenerationBackend {
  readonly name = "mock";
  readonly isMock = true;
  readonly capabilities = {
    kinds: ["image"] as const,
    ref_image: false,
  };

  private assetsRoot: string;
  private flakySeen = new Set<string>();

  constructor(assetsRoot: string) {
    this.assetsRoot = assetsRoot;
  }

  describe(): Record<string, unknown> {
    return { workflow: "mock-stub", model: "1x1-png" };
  }

  async submit(
    _input: GenerationInput,
    ctx: { project_id: string; generation_id: string },
  ): Promise<GenerationJob> {
    const dir = prepareDirUnder(this.assetsRoot, ctx.project_id);
    const file = join(dir, `gen-${ctx.generation_id}.png`);
    writeFileSync(file, STUB_PNG);
    // VO_MOCK_HOLD=1 yields a job that stays "running" until a
    // <file>.release marker appears — lets UI checks exercise the
    // running state without a real backend.
    if (process.env.VO_MOCK_HOLD === "1") {
      return { backend_job_id: `hold:${file}` };
    }
    return { backend_job_id: `mock:${file}` };
  }

  async poll(
    job: GenerationJob,
    _ctx: { project_id: string; generation_id: string },
  ): Promise<GenerationPollResult> {
    // Test markers: "missing:<id>" simulates a definitive remote-absent
    // lookup; "down:<id>" simulates an indeterminate transport failure.
    if (job.backend_job_id.startsWith("missing:")) {
      throw new JobNotFoundError(`No job ${job.backend_job_id.slice(8)}`);
    }
    if (job.backend_job_id.startsWith("down:")) {
      throw new Error("fetch failed");
    }
    // "flaky1:<file>" fails its first poll (transport) then succeeds —
    // lets tests exercise failure → explicit retry → same-job recovery.
    if (job.backend_job_id.startsWith("hold:")) {
      const path = job.backend_job_id.slice(5);
      if (existsSync(`${path}.release`)) {
        return { status: "succeeded", output_files: [path] };
      }
      return { status: "running" };
    }
    if (job.backend_job_id.startsWith("flaky1:")) {
      const path = job.backend_job_id.slice(7);
      const key = `flaky:${path}`;
      if (!this.flakySeen.has(key)) {
        this.flakySeen.add(key);
        throw new Error("fetch failed");
      }
      return { status: "succeeded", output_files: [path] };
    }
    return {
      status: "succeeded",
      output_files: [job.backend_job_id.slice(5)],
    };
  }
}
