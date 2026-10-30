import { mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { BadRequestError } from "../repos/errors.ts";

/**
 * Resolve `segments` under `root` and PROVE the result stays inside
 * root. Rejects empty/"." /".." segments, both Windows and POSIX
 * separators, drive-qualified and absolute paths, and NUL bytes.
 * Call this before any filesystem write so a hostile or buggy caller
 * cannot escape the configured storage root.
 */
export function resolveUnder(root: string, ...segments: string[]): string {
  const base = resolve(root);
  for (const s of segments) {
    if (
      s === "" ||
      s === "." ||
      s === ".." ||
      s.includes("/") ||
      s.includes("\\") ||
      s.includes(":") ||
      s.includes(String.fromCharCode(0)) || // NUL byte
      isAbsolute(s)
    ) {
      throw new BadRequestError(`unsafe path segment: "${s}"`);
    }
  }
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new BadRequestError("path escapes the storage root");
  }
  return target;
}

/** True when `p` resolves strictly inside `root` (root itself is false). */
export function isUnder(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Lexical resolveUnder + mkdir + REAL-path proof: after the directory
 * exists, its canonical location must still sit inside root's real
 * location. This catches symlinks/junctions anywhere in the chain —
 * something a string-only containment check cannot see. Returns the
 * canonical (real) path; build file paths on it so stored paths and
 * the serve-time realpath check agree.
 *
 * LIMITATIONS (verified scope):
 *  - mkdir runs BEFORE the realpath proof, so a rejected call is NOT
 *    side-effect free: it can leave an empty directory inside root, or
 *    — if a link already redirects part of the path — create a
 *    directory at the resolved location outside root. What callers can
 *    rely on is that no file content is written outside root, since
 *    the realpath check runs before any file write.
 *  - This is a check-then-use sequence: a concurrent process swapping
 *    a path component between the check and the subsequent write is
 *    out of scope (single-process threat model — assets_root must not
 *    be writable by untrusted actors).
 */
export function prepareDirUnder(
  root: string,
  ...segments: string[]
): string {
  const target = resolveUnder(root, ...segments);
  mkdirSync(target, { recursive: true });
  const realTarget = realpathSync(target);
  if (!isUnder(realpathSync(resolve(root)), realTarget)) {
    throw new BadRequestError(
      "storage path resolves outside the storage root",
    );
  }
  return realTarget;
}

/**
 * Strip every directory/drive component from an externally supplied
 * name (normalizes "\\" first so Windows-style paths are handled on
 * any platform). Returns a bare filename usable as ONE path segment.
 */
export function safeBasename(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/"));
  const clean = base.replace(/[^\w.\-]/g, "_").slice(0, 80);
  return clean === "" || clean === "." || clean === ".." ? "output" : clean;
}
