import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableError,
} from "../repos/errors.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  private cleanups: (() => void)[] = [];

  onClose(cleanup: () => void): void { this.cleanups.push(cleanup); }
  close(): void { for (const cleanup of this.cleanups.splice(0)) cleanup(); }

  /** Max accepted request body in bytes; over the limit → 413. */
  maxBodyBytes = 32 * 1024 * 1024;

  on(method: string, pattern: string, handler: Handler): void {
    this.routes.push({
      method,
      pattern,
      parts: pattern.split("/").filter(Boolean),
      handler,
    });
  }

  get(p: string, h: Handler): void {
    this.on("GET", p, h);
  }
  post(p: string, h: Handler): void {
    this.on("POST", p, h);
  }
  put(p: string, h: Handler): void {
    this.on("PUT", p, h);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathParts = url.pathname.split("/").filter(Boolean);

    let body: unknown;
    if (req.method === "POST" || req.method === "PUT") {
      try {
        body = await readJsonBody(req, this.maxBodyBytes);
      } catch (err) {
        sendError(res, err);
        return;
      }
    }

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      if (route.parts.length !== pathParts.length) continue;
      const params: Record<string, string> = {};
      let match = true;
      for (const [i, part] of route.parts.entries()) {
        if (part.startsWith(":")) {
          params[part.slice(1)] = decodeURIComponent(pathParts[i]);
        } else if (part !== pathParts[i]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      try {
        await route.handler({ req, res, params, body });
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
  }
}

async function readJsonBody(
  req: IncomingMessage,
  limit: number,
): Promise<unknown> {
  // Fast path: a declared Content-Length already over the limit fails
  // before reading; the loop below still counts actual received bytes
  // so chunked/misdeclared bodies are enforced the same way.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw new PayloadTooLargeError(
      `request body exceeds the ${limit}-byte limit`,
    );
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).length;
    if (received > limit) {
      req.resume();
      throw new PayloadTooLargeError(
        `request body exceeds the ${limit}-byte limit`,
      );
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof NotFoundError) {
    sendJson(res, 404, { error: err.message, code: "not_found" });
  } else if (err instanceof ConflictError) {
    sendJson(res, 409, { error: err.message, code: "conflict" });
  } else if (err instanceof BadRequestError) {
    sendJson(res, 400, { error: err.message, code: "bad_request" });
  } else if (err instanceof UnprocessableError) {
    sendJson(res, 422, { error: err.message, code: "unprocessable" });
  } else if (err instanceof PayloadTooLargeError) {
    sendJson(res, 413, { error: err.message, code: "payload_too_large" });
  } else {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
