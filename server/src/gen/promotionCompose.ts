import { BadRequestError } from "../repos/errors.ts";
import { promotionLineHeight } from "./promotionTextFit.ts";

/** Locations are normalized fractions of the output frame. */
export interface PromotionRect { x: number; y: number; width: number; height: number }
export interface PromotionLayout {
  logo: PromotionRect;
  title: PromotionRect;
}

function rect(value: unknown): PromotionRect {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("Placement must be a rectangle");
  const r = value as Record<string, unknown>;
  const keys = ["x", "y", "width", "height"] as const;
  if (Object.keys(r).length !== keys.length || keys.some((key) => typeof r[key] !== "number" || !Number.isFinite(r[key]))) throw new BadRequestError("Placement requires finite x, y, width and height");
  const x = r.x as number, y = r.y as number, width = r.width as number, height = r.height as number;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw new BadRequestError("Placement must fit within the frame");
  return { x, y, width, height };
}

export function validatePromotionLayout(value: unknown): PromotionLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("Layout must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !("logo" in input) || !("title" in input)) throw new BadRequestError("Layout requires logo and title rectangles");
  return { logo: rect(input.logo), title: rect(input.title) };
}

/** Caller stages inputs under these fixed names in a private directory.
 * User text is never interpolated into the graph; expansion=none prevents
 * drawtext from interpreting percent expressions in the staged UTF-8 file.
 * Text fitting and image dimensions must be checked by the caller. */
export function promotionComposeArgs(layout: PromotionLayout, fontSize: number, frame: { width: number; height: number }, lineCount = 1): string[] {
  const { logo, title } = validatePromotionLayout(layout);
  if (!Number.isSafeInteger(fontSize) || fontSize < 12 || fontSize > 256) throw new BadRequestError("Invalid promotion font size");
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width <= 0 || frame.height <= 0) throw new BadRequestError("Invalid output frame size");
  if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 12) throw new BadRequestError("Invalid title line count");
  const logoWidth = Math.max(1, Math.floor(frame.width * logo.width));
  const logoHeight = Math.max(1, Math.floor(frame.height * logo.height));
  const draws = Array.from({ length: lineCount }, (_, index) => `drawtext=fontfile=font.ttc:ft_load_flags=no_bitmap:textfile=${lineCount === 1 ? "title.txt" : `title-line-${index}.txt`}:expansion=none:fontcolor=white:fontsize=${fontSize}:x=w*${title.x}+4:y=h*${title.y}+4+${index * promotionLineHeight(fontSize)}`).join(",");
  const graph = `[1:v]scale=w=${logoWidth}:h=${logoHeight}:force_original_aspect_ratio=decrease[logo];[0:v][logo]overlay=x=main_w*${logo.x}:y=main_h*${logo.y}:format=auto[branded];[branded]${draws}[out]`;
  return ["-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", "source.mp4", "-protocol_whitelist", "file,pipe", "-loop", "1", "-f", "image2", "-i", "logo.png", "-filter_complex", graph, "-map", "[out]", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-shortest", "-movflags", "+faststart", "output.mp4"];
}
