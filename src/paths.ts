import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, sep } from "node:path";
import { HttpError } from "./httpError.js";

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Directories a task cwd / workspace path may live under. */
export function allowedDirectoryRoots(): string[] {
  const roots: string[] = [];
  const add = (p: string) => {
    const real = realOrNull(p);
    if (real && !roots.includes(real)) roots.push(real);
  };
  add(homedir());
  add(tmpdir());
  const extra = process.env.AGENT_BOARD_ALLOWED_ROOTS;
  if (extra) {
    for (const part of extra.split(delimiter)) {
      if (part.trim()) add(part.trim());
    }
  }
  return roots;
}

export function isInsideRoot(rootReal: string, targetReal: string): boolean {
  if (rootReal === sep) return targetReal === sep || targetReal.startsWith(sep);
  return targetReal === rootReal || targetReal.startsWith(rootReal + sep);
}

/**
 * Absolute, existing directory inside an allowed root, after symlink resolution.
 * `label` is used in error text (`cwd` or `path`).
 */
export function resolveAllowedDirectory(input: string, label = "cwd"): string {
  const raw = input.trim();
  if (!raw) throw new HttpError(400, `${label} required`);
  if (!isAbsolute(raw)) {
    throw new HttpError(400, `${label} must be an absolute path`);
  }
  const real = realOrNull(raw);
  if (!real) throw new HttpError(400, `${label} not found: ${raw}`);
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new HttpError(400, `${label} not found: ${raw}`);
  }
  if (!st.isDirectory()) {
    throw new HttpError(400, `${label} is not a directory: ${raw}`);
  }
  const roots = allowedDirectoryRoots();
  if (!roots.some((r) => isInsideRoot(r, real))) {
    throw new HttpError(400, `${label} is outside allowed roots`);
  }
  return real;
}
