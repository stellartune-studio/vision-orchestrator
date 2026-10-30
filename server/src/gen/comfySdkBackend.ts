import { GenerationRejectedError, JobNotFoundError } from "./backend.ts";
import {
  copyFileSync,
  createReadStream,
  readFileSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { prepareDirUnder, safeBasename } from "../util/paths.ts";
import type {
  GenerationBackend,
  GenerationInput,
  GenerationJob,
  GenerationPollResult,
} from "./backend.ts";
import type { ApiGraph } from "./qwenImageEditProfile.ts";
import { qwenResolutionForArea } from "./qwenResolution.ts";
import { parseWorkflowSelection, selectedGraph } from "./workflowSelection.ts";

/**
 * GenerationBackend over the official Comfy TypeScript SDK
 * (`@comfyorg/sdk`) — the contest-required Comfy Developer Platform
 * path. Talks to Comfy Cloud, a Comfy API deployment, or a self-hosted
 * ComfyUI behind comfy-api-proxy; only COMFY_BASE_URL changes.
 *
 *   app → @comfyorg/sdk → COMFY_BASE_URL (e.g. http://127.0.0.1:8189)
 *         → comfy-api-proxy → local ComfyUI
 *
 * Direct ComfyUI /prompt calls are deliberately NOT used.
 *
 * Status: written against the published SDK surface (v0.5.x); requires
 * a live comfy-api-proxy + ComfyUI to verify — treat as unverified
 * until recorded in docs/verified-integrations.md.
 */

interface WorkflowSpec {
  /** API-format workflow JSON file (server/gen/workflows/) */
  file: string;
  /** node id whose "text" input receives the prompt */
  prompt_node: string;
  prompt_input?: string;
  negative_node?: string;
  negative_input?: string;
  /** node id producing the wanted output (SaveImage etc.) */
  output_node: string;
  /** node id + inputs for size/seed when present in the workflow */
  seed_node?: string;
  seed_input?: string;
  size_node?: string;
  width_input?: string;
  height_input?: string;
  /** scale request dimensions before setting a workflow node (Qwen packed latents use 1/2) */
  size_scale?: number;
  /** node id whose "image" input receives a reference asset */
  ref_image_node?: string;
  ref_image_input?: string;
  /** node id + input for clip duration in seconds (i2v workflows) */
  duration_node?: string;
  duration_input?: string;
  /** node id + input for total-pixel rescale of the ref image */
  megapixels_node?: string;
  megapixels_input?: string;
  /** checkpoint/model override applied to model_node at submit
   *  (e.g. COMFY_CHECKPOINT) — recorded in describe() */
  model?: string;
  model_node?: string;
  model_input?: string;
  /** Use a previously hash-checked graph object instead of loading a file. */
  graph?: ApiGraph;
  workflow_sha256?: string;
  profile_id?: string;
  profile_version?: string;
  model_files?: { role: string; file: string }[];
  edit_source_node?: string;
  edit_source_input?: string;
  resolution_node?: string;
  resolution_input?: string;
  fixed_resolution?: number;
  negative_prompt_node?: string;
  negative_prompt_input?: string;
  fixed_negative_prompt?: string;
  /** Set Qwen image encoder resolution from the requested output area. */
  resolution_from_output_area?: boolean;
}

export class ComfySdkBackend implements GenerationBackend {
  readonly name = "comfy-sdk";
  readonly isMock = false;
  readonly capabilities: GenerationBackend["capabilities"];

  private clientPromise: Promise<import("@comfyorg/sdk").Comfy> | null = null;
  private readonly createClient: () => Promise<import("@comfyorg/sdk").Comfy>;

  /** base: text-to-image; ref: used when ref_images are supplied;
   *  video: i2v workflow (reference image is the first frame). */
  private workflows: {
    base: WorkflowSpec;
    ref?: WorkflowSpec;
    video?: WorkflowSpec;
  };
  private assetsRoot: string;

  constructor(
    workflows: { base: WorkflowSpec; ref?: WorkflowSpec; video?: WorkflowSpec },
    assetsRoot: string,
    createClient?: () => Promise<import("@comfyorg/sdk").Comfy>,
  ) {
    this.workflows = workflows;
    this.assetsRoot = assetsRoot;
    this.createClient =
      createClient ??
      (() => import("@comfyorg/sdk").then(({ Comfy }) => new Comfy()));
    this.capabilities = {
      kinds: workflows.video ? ["image", "video"] : ["image"],
      ref_image:
        workflows.ref !== undefined ||
        workflows.video !== undefined ||
        workflows.base.edit_source_node !== undefined,
      // Each configured workflow has a single ref_image_node — extra
      // references must be rejected, not silently dropped.
      max_ref_images: 1,
    };
  }

  private specFor(input?: GenerationInput): WorkflowSpec {
    const selected = input?.settings.workflow_selection;
    if (selected) {
      const s = parseWorkflowSelection(selected);
      if (s.kind !== input!.kind) throw new Error("Selected workflow kind does not match request");
      return {
        file: s.name, graph: selectedGraph(s, input?.settings),
        prompt_node: s.prompt.node, prompt_input: s.prompt.input,
        output_node: s.output_node,
        ref_image_node: s.reference?.node, ref_image_input: s.reference?.input,
        workflow_sha256: createHash("sha256").update(JSON.stringify(selectedGraph(s, input?.settings))).digest("hex"),
        profile_id: "user-workflow",
      };
    }
    if (input?.kind === "video") {
      if (!this.workflows.video) {
        throw new Error("backend has no video workflow configured");
      }
      return this.workflows.video;
    }
    if (input && input.ref_images.length > 0 && this.workflows.ref) {
      return this.workflows.ref;
    }
    return this.workflows.base;
  }

  configureConnection(endpoint: string): void {
    process.env.COMFY_BASE_URL = endpoint;
    this.clientPromise = null;
  }

  private async client(): Promise<import("@comfyorg/sdk").Comfy> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  releaseLocalReferences(): void {
    // Existing calls keep their own client reference. This does not ask the
    // shared ComfyUI server to unload anything, nor guarantee a GC time.
    this.clientPromise = null;
  }

  private async hashFile(file: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return hash.digest("hex");
  }

  describe(input?: GenerationInput): Record<string, unknown> {
    const spec = this.specFor(input);
    const info: Record<string, unknown> = {
      kind: input?.kind ?? "image",
      workflow_file: spec.file,
      prompt_node: spec.prompt_node,
      output_node: spec.output_node,
      ref_image: input ? input.ref_images.length > 0 : spec === this.workflows.ref,
      connection_origin: new URL(process.env.COMFY_BASE_URL ?? "https://cloud.comfy.org").origin,
    };
    // Extract the model files the workflow actually loads so the
    // persisted record names them (checkpoint, unet, clip, vae).
    try {
      const wf =
        spec.graph ??
        (JSON.parse(readFileSync(spec.file, "utf8")) as Record<
          string,
          { class_type?: string; inputs?: Record<string, unknown> }
        >);
      const vaes: string[] = [];
      for (const node of Object.values(wf)) {
        const ins = node.inputs ?? {};
        if (node.class_type === "CheckpointLoaderSimple" && ins["ckpt_name"]) {
          info["model"] = ins["ckpt_name"];
        }
        if (node.class_type === "UNETLoader" && ins["unet_name"]) {
          info["model"] = ins["unet_name"];
        }
        if (node.class_type === "CLIPLoader" && ins["clip_name"]) {
          info["text_encoder"] = ins["clip_name"];
        }
        if (node.class_type === "VAELoader" && ins["vae_name"]) {
          vaes.push(String(ins["vae_name"]));
        }
      }
      if (vaes.length > 0) info["vae"] = vaes;
    } catch {
      info["model"] = "unreadable";
    }
    if (spec.model) info["model"] = spec.model;
    if (spec.profile_id) info["profile_id"] = spec.profile_id;
    if (spec.profile_version) info["profile_version"] = spec.profile_version;
    if (spec.workflow_sha256) info["workflow_sha256"] = spec.workflow_sha256;
    if (spec.model_files) info["model_files"] = spec.model_files;
    if (input?.settings.workflow_selection) {
      info["selected_inputs"] = input.settings.workflow_selection.values;
      info["selection_name"] = input.settings.workflow_selection.name;
    }
    if (spec.size_node) {
      const scale = spec.size_scale ?? 1;
      info["applied_dimensions"] = {
        node: spec.size_node,
        width_input: spec.width_input ?? "width",
        width:
          input?.settings.width == null
            ? undefined
            : Math.round(input.settings.width * scale),
        height_input: spec.height_input ?? "height",
        height:
          input?.settings.height == null
            ? undefined
            : Math.round(input.settings.height * scale),
      };
    }
    if (spec.resolution_from_output_area) {
      info["applied_resolution"] = {
        node: spec.resolution_node,
        input: spec.resolution_input,
        value: typeof input?.settings.qwen_reference_resolution === "number"
          ? input.settings.qwen_reference_resolution
          : qwenResolutionForArea(input?.settings.width, input?.settings.height),
        preserves_reference_aspect_ratio: true,
      };
    }
    if (spec.edit_source_node) {
      info["edit_source_node"] = spec.edit_source_node;
      info["edit_source_input"] = spec.edit_source_input;
      info["applied_inputs"] = {
        prompt: {
          node: spec.prompt_node,
          input: spec.prompt_input ?? "text",
          value: input?.prompt,
        },
        edit_source: {
          node: spec.edit_source_node,
          input: spec.edit_source_input ?? "image",
          asset_id: input?.resolved_refs.edit_source_asset_id,
          sha256: input?.resolved_refs.edit_source_sha256,
        },
        seed: {
          node: spec.seed_node,
          input: spec.seed_input ?? "seed",
          value: input?.settings.seed,
        },
        resolution: {
          node: spec.resolution_node,
          input: spec.resolution_input,
          value: spec.fixed_resolution,
        },
        negative_prompt: {
          node: spec.negative_prompt_node,
          input: spec.negative_prompt_input,
          value: spec.fixed_negative_prompt,
        },
      };
    }
    return info;
  }

  async submit(
    input: GenerationInput,
    ctx: { project_id: string; generation_id: string },
  ): Promise<GenerationJob> {
    let submissionStarted = false;
    try {
    const spec = this.specFor(input);
    // Reject before touching the client: the recorded input must equal
    // the input actually used — never submit with silently dropped
    // reference images.
    if (input.ref_images.length > (this.capabilities.max_ref_images ?? 1)) {
      throw new Error(
        `backend accepts at most ${this.capabilities.max_ref_images} ` +
          `reference image(s); got ${input.ref_images.length}`,
      );
    }
    if (input.kind === "video" && input.ref_images.length === 0 && !input.settings.workflow_selection) {
      // The bundled i2v workflows animate the reference frame; without
      // one there is nothing to condition on.
      throw new Error(
        "video generation requires a reference image (first frame)",
      );
    }
    if (input.kind === "video" && spec === this.workflows.video && spec.size_node) {
      const { width, height } = input.settings;
      // The bundled i2v workflows encode on a 32-pixel grid. Reject
      // unspecified or incompatible sizes instead of silently resizing
      // the output.
      if (![width, height].every((n) => typeof n === "number" && Number.isInteger(n) && n > 0 && n % 32 === 0)) {
        throw new Error("video workflow requires output width and height as positive multiples of 32; adopt an output aspect ratio first");
      }
    }
    if (spec.edit_source_node && input.ref_images.length !== 1) {
      throw new Error("Qwen edit requires exactly one explicit source image");
    }
    if (
      spec.edit_source_node &&
      (input.settings.width != null || input.settings.height != null)
    ) {
      throw new Error(
        "Qwen profile does not accept output width/height settings",
      );
    }
    let sourceStageDir: string | undefined;
    try {
      let sourcePath = input.ref_images[0];
      if (spec.edit_source_node) {
        const expectedHash = input.resolved_refs.edit_source_sha256;
        if (!expectedHash)
          throw new Error("Qwen edit source is missing its recorded SHA-256");
        const projectAssets = prepareDirUnder(this.assetsRoot, ctx.project_id);
        sourceStageDir = mkdtempSync(join(projectAssets, ".qwen-edit-source-"));
        sourcePath = join(
          sourceStageDir,
          `source${extname(input.ref_images[0])}`,
        );
        copyFileSync(input.ref_images[0], sourcePath);
        const stagedHash = await this.hashFile(sourcePath);
        if (stagedHash.toLowerCase() !== expectedHash.toLowerCase()) {
          throw new Error("Qwen edit source changed after request validation");
        }
      } else if (input.settings.qwen_reference_size && input.ref_images.length === 1) {
        const expectedHash = (input.settings.qwen_reference_size as { source_sha256?: unknown }).source_sha256;
        if (typeof expectedHash !== "string") throw new Error("Qwen reference hash is missing");
        const projectAssets = prepareDirUnder(this.assetsRoot, ctx.project_id);
        sourceStageDir = mkdtempSync(join(projectAssets, ".qwen-reference-source-"));
        sourcePath = join(sourceStageDir, `source${extname(input.ref_images[0])}`);
        copyFileSync(input.ref_images[0], sourcePath);
        if ((await this.hashFile(sourcePath)).toLowerCase() !== expectedHash.toLowerCase()) throw new Error("Qwen reference changed after size confirmation");
      }
      const client = await this.client();
      const wf = spec.graph
        ? client.workflows.fromJson(
            structuredClone(
              spec.graph,
            ) as import("@comfyorg/sdk").WorkflowGraph,
          )
        : await client.workflows.fromFile(spec.file);

      wf.setInput(spec.prompt_node, spec.prompt_input ?? "text", input.prompt);
      if (input.negative_prompt && spec.negative_node) {
        wf.setInput(
          spec.negative_node,
          spec.negative_input ?? "text",
          input.negative_prompt,
        );
      }
      if (spec.seed_node && input.settings.seed != null) {
        wf.setInput(
          spec.seed_node,
          spec.seed_input ?? "seed",
          input.settings.seed,
        );
      }
      if (spec.resolution_node && spec.resolution_input) {
        const resolution =
          spec.fixed_resolution ??
          (spec.resolution_from_output_area
            ? (typeof input.settings.qwen_reference_resolution === "number" ? input.settings.qwen_reference_resolution : qwenResolutionForArea(input.settings.width, input.settings.height))
            : undefined);
        if (resolution !== undefined) {
          wf.setInput(spec.resolution_node, spec.resolution_input, resolution);
        }
      }
      if (spec.edit_source_node) {
        const asset = await client.assets.fromFile(sourcePath);
        wf.setInput(
          spec.edit_source_node,
          spec.edit_source_input ?? "image",
          asset,
        );
      }
      if (spec.size_node) {
        const scale = spec.size_scale ?? 1;
        if (input.settings.width != null) {
          wf.setInput(
            spec.size_node,
            spec.width_input ?? "width",
            Math.round(input.settings.width * scale),
          );
        }
        if (input.settings.height != null) {
          wf.setInput(
            spec.size_node,
            spec.height_input ?? "height",
            Math.round(input.settings.height * scale),
          );
        }
      }
      if (spec.model && spec.model_node) {
        wf.setInput(
          spec.model_node,
          spec.model_input ?? "ckpt_name",
          spec.model,
        );
      }
      if (
        spec.duration_node &&
        typeof input.settings["duration_seconds"] === "number"
      ) {
        wf.setInput(
          spec.duration_node,
          spec.duration_input ?? "value",
          input.settings["duration_seconds"],
        );
      }
      if (
        spec.megapixels_node &&
        typeof input.settings["megapixels"] === "number"
      ) {
        wf.setInput(
          spec.megapixels_node,
          spec.megapixels_input ?? "megapixels",
          input.settings["megapixels"],
        );
      }
      if (input.ref_images.length > 0 && !spec.edit_source_node) {
        if (!spec.ref_image_node) {
          throw new Error(
            "input requires a reference image but the selected workflow has no ref_image_node",
          );
        }
        const asset = await client.assets.fromFile(sourcePath);
        wf.setInput(
          spec.ref_image_node,
          spec.ref_image_input ?? "image",
          asset,
        );
      }

      // generation_id doubles as the idempotency key AND the job's
      // metadata label: a retry of the same generation cannot
      // double-submit, and a submit whose response was lost can be
      // found again by scanning jobs for this label. comfy-api-proxy
      // requires metadata as an opaque STRING (it rejects the SDK's
      // record form with invalid_request) — the cast is deliberate.
      submissionStarted = true;
      const job = await client.submit(wf, {
        idempotencyKey: ctx.generation_id,
        metadata: `vo_generation_id=${ctx.generation_id}` as unknown as Record<
          string,
          string
        >,
      });
      return { backend_job_id: job.id };
    } finally {
      if (sourceStageDir)
        rmSync(sourceStageDir, { recursive: true, force: true });
    }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (!submissionStarted || status === 400 || status === 422) throw new GenerationRejectedError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async findJob(ctx: {
    project_id: string;
    generation_id: string;
  }): Promise<GenerationJob | null> {
    // The SDK's JobSummary normalizes metadata into a record and drops
    // the proxy's opaque string; the underlying Job model still carries
    // it verbatim (a private field on the same SDK object — the runtime
    // value is what was sent on the wire).
    const client = await this.client();
    const label = `vo_generation_id=${ctx.generation_id}`;
    let seen = 0;
    for await (const summary of client.listJobs({ limit: 50 })) {
      if (++seen > 50) break;
      const job = await client.jobs.get(summary.id);
      const raw = (job as unknown as { model?: { metadata?: unknown } }).model
        ?.metadata;
      if (String(raw) === label) {
        return { backend_job_id: job.id };
      }
    }
    return null;
  }

  async poll(
    job: GenerationJob,
    ctx: {
      project_id: string;
      generation_id: string;
      output_node?: string;
    },
  ): Promise<GenerationPollResult> {
    const client = await this.client();
    let remote: Awaited<ReturnType<typeof client.jobs.get>>;
    try {
      remote = await client.jobs.get(job.backend_job_id);
    } catch (e) {
      // Definitive absence = the observed proxy response whose ENTIRE
      // message is "No job <id>" AND the id is the one we queried —
      // ambiguous text or a different id stays transport failure.
      const absent =
        e instanceof Error &&
        /^No job\s+([0-9a-fA-F-]+)\.?\s*$/.exec(e.message);
      if (absent && absent[1] === job.backend_job_id) {
        throw new JobNotFoundError(e.message);
      }
      throw e;
    }
    const status = String(
      (remote as { status?: string }).status ?? "",
    ).toLowerCase();

    if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled" || status === "expired") {
      return { status: "failed", error: `remote status ${status}` };
    }
    if (status !== "completed" && status !== "succeeded" && status !== "done") {
      return { status: "running" };
    }

    const outputs = await remote.getOutputs(
      ctx.output_node ?? this.workflows.base.output_node,
    );
    if (!outputs || outputs.length === 0) {
      return { status: "failed", error: "job completed with no outputs" };
    }
    const dir = prepareDirUnder(this.assetsRoot, ctx.project_id);
    // A racing duplicate poll of the same job downloads the same
    // outputs — each attempt stages under its own id so the loser's
    // download can never overwrite the file the winner registers.
    const attempt = randomUUID();
    const files: string[] = [];
    for (const [i, out] of outputs.entries()) {
      // The remote-supplied name is reduced to a bare basename and
      // prefixed with server-side ids — remote output never chooses
      // its own save path or collides with another generation.
      const file = join(
        dir,
        `${ctx.generation_id}-${attempt}-${i}-${safeBasename(out.name ?? `output-${i}`)}`,
      );
      await out.toFile(file);
      files.push(file);
    }
    return { status: "succeeded", output_files: files };
  }

  async cancel(job: GenerationJob): Promise<void> {
    const client = await this.client();
    const remote = await client.jobs.get(job.backend_job_id);
    await remote.cancel();
  }
}
