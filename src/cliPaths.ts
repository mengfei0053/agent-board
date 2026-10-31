/** CLI command path overrides (meta.cli_paths). Empty → PATH lookup by default name. */
import { existsSync } from "node:fs";
import { getPool } from "./db.js";
import { HttpError } from "./httpError.js";
import { spawnCollect } from "./spawnCollect.js";

export const CLI_COMMAND_KEYS = ["pi", "claude", "agent", "devin", "codex"] as const;
export type CliCommandKey = (typeof CLI_COMMAND_KEYS)[number];

export const CLI_COMMAND_DEFAULTS: Record<CliCommandKey, string> = {
  pi: "pi",
  claude: "claude",
  agent: "agent",
  devin: "devin",
  codex: "codex",
};

/** Human labels for settings UI (kind → spawn binary). */
export const CLI_COMMAND_LABELS: Record<CliCommandKey, string> = {
  pi: "pi",
  claude: "Claude Code (claude)",
  agent: "Cursor CLI (agent)",
  devin: "Devin CLI (devin)",
  codex: "Codex CLI (codex)",
};

const META_KEY = "cli_paths";

/** In-memory overrides (only non-empty paths). */
let overrides: Partial<Record<CliCommandKey, string>> = {};

function isKey(k: string): k is CliCommandKey {
  return (CLI_COMMAND_KEYS as readonly string[]).includes(k);
}

function normalizeOverride(raw: unknown, strict = false): string {
  if (typeof raw !== "string") return "";
  if (raw.includes("\0")) {
    if (strict) throw new HttpError(400, "cli path must not contain NUL");
    return "";
  }
  return raw.trim();
}

/** Pure parse of meta.cli_paths JSON (exported for tests). */
export function parseCliPathsJson(
  raw: string | null | undefined,
): Partial<Record<CliCommandKey, string>> {
  if (!raw?.trim()) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<CliCommandKey, string>> = {};
    for (const k of CLI_COMMAND_KEYS) {
      const v = normalizeOverride(obj[k]);
      if (v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadCliPathOverrides(): Promise<void> {
  const p = getPool();
  const res = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [META_KEY],
  );
  overrides = parseCliPathsJson(res.rows[0]?.value);
}

/** Command string passed to spawn / spawnSync. */
export function resolveCliCommand(key: CliCommandKey): string {
  const o = overrides[key]?.trim();
  return o || CLI_COMMAND_DEFAULTS[key];
}

const whichCache = new Map<string, { path: string | null; at: number }>();
const WHICH_TTL_MS = 30_000;

function whichFromCache(cmd: string): string | null | undefined {
  const hit = whichCache.get(cmd);
  if (!hit) return undefined;
  if (Date.now() - hit.at > WHICH_TTL_MS) return undefined;
  return hit.path;
}

/**
 * Best-effort absolute path for UI (does not affect spawn).
 * Absolute paths are a sync exists check. PATH lookups use the cache filled
 * by {@link whichResolvedAsync} so a settings read does not spawnSync.
 */
export function whichResolved(cmd: string): string | null {
  const c = cmd.trim();
  if (!c) return null;
  if (c.includes("/") || c.startsWith(".")) {
    return existsSync(c) ? c : null;
  }
  return whichFromCache(c) ?? null;
}

/** PATH lookup via async `command -v`. Result is cached. */
export async function whichResolvedAsync(cmd: string): Promise<string | null> {
  const c = cmd.trim();
  if (!c) return null;
  if (c.includes("/") || c.startsWith(".")) {
    return existsSync(c) ? c : null;
  }
  const cached = whichFromCache(c);
  if (cached !== undefined) return cached;
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  const r = await spawnCollect("sh", ["-c", 'command -v -- "$1"', "sh", c], {
    env,
    timeoutMs: 3_000,
  });
  const out = (r.stdout || "").trim().split(/\r?\n/)[0]?.trim() || null;
  whichCache.set(c, { path: out, at: Date.now() });
  return out;
}

export async function getCliPathSettingsResolved(): Promise<
  ReturnType<typeof getCliPathSettings>
> {
  await Promise.all(
    CLI_COMMAND_KEYS.map(async (k) => {
      await whichResolvedAsync(resolveCliCommand(k));
    }),
  );
  return getCliPathSettings();
}

export type CliPathSetting = {
  default: string;
  override: string;
  effective: string;
  resolved: string | null;
  label: string;
};

export function getCliPathSettings(): {
  cliPaths: Record<CliCommandKey, CliPathSetting>;
} {
  const cliPaths = {} as Record<CliCommandKey, CliPathSetting>;
  for (const k of CLI_COMMAND_KEYS) {
    const effective = resolveCliCommand(k);
    cliPaths[k] = {
      default: CLI_COMMAND_DEFAULTS[k],
      override: overrides[k] || "",
      effective,
      resolved: whichResolved(effective),
      label: CLI_COMMAND_LABELS[k],
    };
  }
  return { cliPaths };
}

/** Replace overrides from a partial map; empty string clears that key. */
export async function setCliPathOverrides(
  input: Partial<Record<CliCommandKey, string>>,
): Promise<ReturnType<typeof getCliPathSettings>> {
  const next: Partial<Record<CliCommandKey, string>> = { ...overrides };
  for (const [rawKey, rawVal] of Object.entries(input)) {
    if (!isKey(rawKey)) continue;
    const v = normalizeOverride(rawVal, true);
    if (v) next[rawKey] = v;
    else delete next[rawKey];
  }
  const planned = { next, json: cliPathsJson(next) };
  const p = getPool();
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, planned.json],
  );
  overrides = planned.next;
  return getCliPathSettings();
}

function cliPathsJson(next: Partial<Record<CliCommandKey, string>>): string {
  return JSON.stringify(
    Object.fromEntries(
      CLI_COMMAND_KEYS.filter((k) => next[k]).map((k) => [k, next[k]!]),
    ),
  );
}

/** Pure next-state for an atomic settings write. Does not touch memory or DB. */
export function planCliPathOverrides(
  input: Partial<Record<CliCommandKey, string>>,
): { next: Partial<Record<CliCommandKey, string>>; json: string } {
  const next: Partial<Record<CliCommandKey, string>> = { ...overrides };
  for (const [rawKey, rawVal] of Object.entries(input)) {
    if (!isKey(rawKey)) continue;
    const v = normalizeOverride(rawVal, true);
    if (v) next[rawKey] = v;
    else delete next[rawKey];
  }
  return { next, json: cliPathsJson(next) };
}

export function applyCliPathMemory(next: Partial<Record<CliCommandKey, string>>): void {
  overrides = { ...next };
}

/** Clear all CLI path overrides. */
export async function clearCliPathOverrides(): Promise<ReturnType<typeof getCliPathSettings>> {
  const p = getPool();
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, "{}"],
  );
  overrides = {};
  return getCliPathSettings();
}

/** @internal test helper — does not persist. */
export function _resetCliPathOverridesForTests(
  next: Partial<Record<CliCommandKey, string>> = {},
): void {
  overrides = { ...next };
}
