import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "../types.js";

function readJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function resolveDefaultModel(kind: AgentKind): string | undefined {
  const home = homedir();
  if (kind === "pi") {
    const s = readJson(join(home, ".pi/agent/settings.json"));
    const m = s?.defaultModel || s?.model;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  if (kind === "cursor") {
    const s = readJson(join(home, ".cursor/cli-config.json"));
    const m =
      s?.selectedModel?.modelId ||
      s?.model?.modelId ||
      s?.model?.displayModelId ||
      s?.model;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  if (kind === "claude") {
    const s = readJson(join(home, ".claude/settings.json"));
    const m = s?.model || s?.defaultModel;
    if (typeof m === "string" && m.trim()) return m.trim();
    // fallback: most recent lastModelUsage key across projects
    const root = readJson(join(home, ".claude.json"));
    const projects = root?.projects;
    if (projects && typeof projects === "object") {
      let best: { model: string; tokens: number } | null = null;
      for (const proj of Object.values(projects) as any[]) {
        const usage = proj?.lastModelUsage;
        if (!usage || typeof usage !== "object") continue;
        for (const [model, u] of Object.entries(usage) as [string, any][]) {
          const tokens = Number(u?.outputTokens || 0) + Number(u?.inputTokens || 0);
          if (!best || tokens > best.tokens) best = { model, tokens };
        }
      }
      if (best?.model) return best.model;
    }
  }
  return undefined;
}
