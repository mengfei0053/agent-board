import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isInsideRoot } from "./paths.js";

const home = homedir();

function homeReal(): string {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

function safeResolve(input: string): string {
  const raw = (input || home).trim() || home;
  const abs = resolve(raw.startsWith("~") ? join(home, raw.slice(1)) : raw);
  let target: string;
  try {
    // Follow symlinks so a link inside home cannot list an outside directory.
    target = realpathSync(abs);
  } catch {
    throw new Error("path not found");
  }
  if (!isInsideRoot(homeReal(), target)) {
    throw new Error("path outside home is not allowed");
  }
  return target;
}

export function listDirs(pathInput: string) {
  const path = safeResolve(pathInput);
  const st = statSync(path);
  if (!st.isDirectory()) throw new Error("not a directory");
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  return {
    path,
    parent: path === home ? null : dirname(path),
    entries,
  };
}

export { home as browseHome };
