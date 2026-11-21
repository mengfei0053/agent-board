import { getPool } from "./db.js";
import { HttpError } from "./httpError.js";
import type { AgentKind } from "./types.js";

/** Non-secret routing only; BDK credentials never go into board settings. */
export type GrokBotSettings = { enabled: boolean; slug: string };
const defaults: GrokBotSettings = { enabled: false, slug: "" };
let settings = defaults;

export function parseGrokBotSettings(value: unknown): GrokBotSettings {
  if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean" ||
      !("slug" in value) || typeof value.slug !== "string" || Object.keys(value).length !== 2) {
    throw new HttpError(400, "grokBot requires a boolean enabled field and a slug");
  }
  const slug = value.slug.trim();
  if ((slug || value.enabled) && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new HttpError(400, "invalid Grok Bot slug");
  }
  return { enabled: value.enabled, slug };
}

export async function loadGrokBot(): Promise<void> {
  const result = await getPool().query<{ value: string }>("SELECT value FROM meta WHERE key = $1", ["grok_bot"]);
  try { settings = parseGrokBotSettings(JSON.parse(result.rows[0]?.value ?? "null")); }
  catch { settings = defaults; }
}

export function getGrokBotSettings(): GrokBotSettings { return { ...settings }; }
export function applyGrokBotSettings(value = defaults): void { settings = { ...value }; }

// A deployed bot owns its model and workspace; local upload paths are not transferable.
export function validateGrokOptions(kind: AgentKind, opts: {
  model?: string; thinkingEffort?: string; attachments?: readonly unknown[]; useGitWorktree?: boolean;
}): void {
  if (kind === "grok" && (opts.model?.trim() || opts.thinkingEffort?.trim() || opts.attachments?.length || opts.useGitWorktree)) {
    throw new HttpError(400, "Grok Bot does not support local attachments, worktrees, or per-task model overrides");
  }
}

export function requireEnabledAgent(kind: AgentKind): void {
  if (kind === "grok" && !settings.enabled) throw new HttpError(409, "Grok Bot is disabled in board settings");
}
