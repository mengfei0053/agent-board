import { readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";

const home = homedir();

function safeResolve(input: string): string {
  const raw = (input || home).trim() || home;
  const abs = resolve(raw.startsWith("~") ? join(home, raw.slice(1)) : raw);
  const norm = normalize(abs);
  // stay under home for v0.1 safety
  if (!(norm === home || norm.startsWith(home + sep))) {
    throw new Error("path outside home is not allowed");
  }
  return norm;
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
