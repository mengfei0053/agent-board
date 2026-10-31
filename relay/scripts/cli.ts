import path from "node:path";
import { fileURLToPath } from "node:url";

export function invokedDirectly(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(metaUrl);
}
