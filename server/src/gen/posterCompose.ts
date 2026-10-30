import { BadRequestError } from "../repos/errors.ts";

/** Rectangles are pixel-aligned and copied from the corresponding source canvas. */
export interface PosterLayer { kind: "still" | "motion"; x: number; y: number; width: number; height: number; loop_frames?: number }
export interface PosterLayout { width: number; height: number; fps: number; duration: number; layers: PosterLayer[] }

// Bounded decoded frame cache: prevents an unbounded FFmpeg loop buffer.
const MAX_CACHED_PIXELS = 32_000_000;
const MAX_LAYERS = 8;
const MAX_OUTPUT_SECONDS = 60;

export function validatePosterLayout(value: unknown): PosterLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("Poster layout must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["width", "height", "fps", "duration", "layers"].includes(key))) throw new BadRequestError("Unknown poster layout field");
  const { width, height, fps, duration } = v;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 2 || (height as number) < 2 || (width as number) % 2 || (height as number) % 2 || (width as number) > 8192 || (height as number) > 8192) throw new BadRequestError("Poster dimensions must be even pixels within the supported range");
  if (!Number.isSafeInteger(fps) || (fps as number) < 1 || (fps as number) > 60 || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > MAX_OUTPUT_SECONDS) throw new BadRequestError("Invalid poster frame rate or duration");
  if (!Array.isArray(v.layers) || !v.layers.length || v.layers.length > MAX_LAYERS) throw new BadRequestError("Poster requires one to eight ordered layers");
  let cachePixels = 0;
  const layers = v.layers.map((item: unknown): PosterLayer => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BadRequestError("Invalid poster layer");
    const l = item as Record<string, unknown>;
    if (Object.keys(l).some((key) => !["kind", "x", "y", "width", "height", "loop_frames"].includes(key)) || (l.kind !== "still" && l.kind !== "motion")) throw new BadRequestError("Invalid poster layer type");
    for (const key of ["x", "y", "width", "height"] as const) if (!Number.isSafeInteger(l[key]) || (l[key] as number) < (key === "width" || key === "height" ? 2 : 0) || (l[key] as number) % 2) throw new BadRequestError("Layer rectangles must use even pixel coordinates");
    const x = l.x as number, y = l.y as number, w = l.width as number, h = l.height as number;
    if (x + w > (width as number) || y + h > (height as number)) throw new BadRequestError("Poster layer must fit within the canvas");
    if (l.kind === "still") {
      if (l.loop_frames !== undefined) throw new BadRequestError("A still layer cannot specify a loop");
      return { kind: "still", x, y, width: w, height: h };
    }
    if (!Number.isSafeInteger(l.loop_frames) || (l.loop_frames as number) < 1 || (l.loop_frames as number) > (fps as number) * MAX_OUTPUT_SECONDS) throw new BadRequestError("Motion loop must specify a bounded number of frames");
    cachePixels += w * h * (l.loop_frames as number);
    if (cachePixels > MAX_CACHED_PIXELS) throw new BadRequestError("Motion loops exceed the decoded frame cache limit");
    return { kind: "motion", x, y, width: w, height: h, loop_frames: l.loop_frames as number };
  });
  if (!layers.some((layer) => layer.kind === "motion")) throw new BadRequestError("At least one motion region is required");
  return { width: width as number, height: height as number, fps: fps as number, duration, layers };
}

/** Build a graph for a verified still canvas and matching-size motion clip.
 * Input bytes and dimensions/available frames must be verified by the caller.
 * Layer order is back to front; loop frame counts use the selected output fps. */
export function posterComposeArgs(value: unknown): string[] {
  const layout = validatePosterLayout(value);
  const stillCount = layout.layers.filter((layer) => layer.kind === "still").length;
  const motionCount = layout.layers.length - stillCount;
  const stillLabels = Array.from({ length: stillCount }, (_, i) => `[still${i}]`).join("");
  const motionLabels = Array.from({ length: motionCount }, (_, i) => `[motion${i}]`).join("");
  const graph = [`[0:v]fps=${layout.fps},split=${stillCount + 1}[base]${stillLabels}`];
  graph.push(motionCount === 1 ? `[1:v]fps=${layout.fps}[motion0]` : `[1:v]fps=${layout.fps},split=${motionCount}${motionLabels}`);
  let still = 0, motion = 0;
  layout.layers.forEach((layer, index) => {
    const input = layer.kind === "still" ? `still${still++}` : `motion${motion++}`;
    const crop = `crop=${layer.width}:${layer.height}:${layer.x}:${layer.y}`;
    const loop = layer.kind === "motion" ? `,trim=end_frame=${layer.loop_frames},setpts=PTS-STARTPTS,loop=loop=-1:size=${layer.loop_frames}:start=0,setpts=N/(${layout.fps}*TB)` : "";
    graph.push(`[${input}]${crop}${loop}[layer${index}]`);
    graph.push(`[${index ? `canvas${index - 1}` : "base"}][layer${index}]overlay=${layer.x}:${layer.y}:eof_action=pass[canvas${index}]`);
  });
  return ["-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-loop", "1", "-f", "image2", "-i", "still.png", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", "motion.mp4", "-filter_complex", graph.join(";"), "-map", `[canvas${layout.layers.length - 1}]`, "-t", String(layout.duration), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", "output.mp4"];
}
