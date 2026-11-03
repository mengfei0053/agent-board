/**
 * Per-agent custom environment variables for child processes (meta.process_env).
 *
 * Proxy variables are configured separately (`proxyEnv.ts`) and cannot be set
 * here. Values are stored as plain strings: the settings document and the
 * settings page treat the board operator as trusted, same as proxy overrides.
 */
import { getPool } from "./db.js";
import { CLI_COMMAND_KEYS, type CliCommandKey } from "./cliPaths.js";
import { HttpError } from "./httpError.js";

export const MAX_PROCESS_ENV_PER_KIND = 50;
export const MAX_PROCESS_ENV_VALUE_CHARS = 8_192;

const META_KEY = "process_env";

/** POSIX-style variable name. Kept strict so `spawn` never sees odd keys. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Owned by `proxyEnv` or the board control plane; configure them elsewhere. */
const RESERVED_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "DATABASE_URL",
  "AGENT_BOARD_WEBHOOK_SECRET",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
]);

export type ProcessEnvMap = Record<string, string>;
export type ProcessEnvByKind = Partial<Record<CliCommandKey, ProcessEnvMap>>;

/** In-memory overrides, keyed by agent kind. */
let overrides: ProcessEnvByKind = {};

function isKind(k: string): k is CliCommandKey {
  return (CLI_COMMAND_KEYS as readonly string[]).includes(k);
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/** Lenient parse of one stored kind map: drop anything unusable. */
function parseKindMap(raw: unknown): ProcessEnvMap {
  if (!isPlainObject(raw)) return {};
  const out: ProcessEnvMap = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_PROCESS_ENV_PER_KIND) break;
    if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) continue;
    if (typeof value !== "string") continue;
    if (!value.trim()) continue;
    if (value.length > MAX_PROCESS_ENV_VALUE_CHARS || value.includes("\0")) continue;
    out[key] = value;
    count += 1;
  }
  return out;
}

/** Pure parse of meta.process_env JSON (exported for tests). */
export function parseProcessEnvJson(raw: string | null | undefined): ProcessEnvByKind {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return {};
    const byKind: ProcessEnvByKind = {};
    for (const kind of CLI_COMMAND_KEYS) {
      if (!(kind in parsed)) continue;
      const map = parseKindMap(parsed[kind]);
      if (Object.keys(map).length) byKind[kind] = map;
    }
    return byKind;
  } catch {
    return {};
  }
}

function serialize(byKind: ProcessEnvByKind): string {
  const out: Record<string, ProcessEnvMap> = {};
  for (const kind of CLI_COMMAND_KEYS) {
    const map = byKind[kind];
    if (!map || !Object.keys(map).length) continue;
    out[kind] = { ...map };
  }
  return JSON.stringify(out);
}

async function persist(byKind: ProcessEnvByKind): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, serialize(byKind)],
  );
}

export async function loadProcessEnvOverrides(): Promise<void> {
  const p = getPool();
  const res = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [META_KEY],
  );
  overrides = parseProcessEnvJson(res.rows[0]?.value);
}

export function getProcessEnvSettings(): {
  processEnv: Record<CliCommandKey, ProcessEnvMap>;
} {
  const processEnv = {} as Record<CliCommandKey, ProcessEnvMap>;
  for (const kind of CLI_COMMAND_KEYS) {
    processEnv[kind] = { ...(overrides[kind] || {}) };
  }
  return { processEnv };
}

/** Stored custom variables for one kind (copy). */
export function customProcessEnvForKind(kind: CliCommandKey): ProcessEnvMap {
  return { ...(overrides[kind] || {}) };
}

/**
 * Pure next-state for an atomic settings write. Each provided kind is replaced
 * wholesale; an empty object clears that kind. Omitted kinds stay unchanged.
 * Does not touch memory or DB.
 */
export function planProcessEnvOverrides(input: unknown): {
  next: ProcessEnvByKind;
  json: string;
} {
  if (!isPlainObject(input)) {
    throw new HttpError(400, "processEnv must be an object");
  }
  const next: ProcessEnvByKind = { ...overrides };
  for (const [rawKind, rawMap] of Object.entries(input)) {
    if (!isKind(rawKind)) {
      throw new HttpError(400, `unknown processEnv kind: ${rawKind}`);
    }
    if (!isPlainObject(rawMap)) {
      throw new HttpError(400, `processEnv.${rawKind} must be an object`);
    }
    const entries = Object.entries(rawMap);
    if (entries.length > MAX_PROCESS_ENV_PER_KIND) {
      throw new HttpError(400, `processEnv.${rawKind} exceeds ${MAX_PROCESS_ENV_PER_KIND} entries`);
    }
    const kindNext: ProcessEnvMap = {};
    for (const [rawKey, rawValue] of entries) {
      if (!KEY_RE.test(rawKey)) {
        throw new HttpError(400, `processEnv.${rawKind} has an invalid key`);
      }
      if (RESERVED_KEYS.has(rawKey)) {
        throw new HttpError(400, `processEnv.${rawKind}.${rawKey} is reserved`);
      }
      if (rawValue == null) continue;
      if (typeof rawValue !== "string") {
        throw new HttpError(400, `processEnv.${rawKind}.${rawKey} must be a string`);
      }
      if (rawValue.includes("\0")) {
        throw new HttpError(400, `processEnv.${rawKind}.${rawKey} must not contain NUL`);
      }
      if (rawValue.length > MAX_PROCESS_ENV_VALUE_CHARS) {
        throw new HttpError(400, `processEnv.${rawKind}.${rawKey} is too long`);
      }
      if (!rawValue.trim()) continue;
      kindNext[rawKey] = rawValue;
    }
    if (Object.keys(kindNext).length) next[rawKind] = kindNext;
    else delete next[rawKind];
  }
  return { next, json: serialize(next) };
}

export function applyProcessEnvMemory(next: ProcessEnvByKind): void {
  overrides = next;
}

/** Replace one or more kinds immediately (used by non-HTTP callers/tests). */
export async function setProcessEnvOverrides(input: unknown): Promise<
  ReturnType<typeof getProcessEnvSettings>
> {
  const planned = planProcessEnvOverrides(input);
  await persist(planned.next);
  overrides = planned.next;
  return getProcessEnvSettings();
}

export async function clearProcessEnvOverrides(): Promise<
  ReturnType<typeof getProcessEnvSettings>
> {
  await persist({});
  overrides = {};
  return getProcessEnvSettings();
}

/** @internal test helper — does not persist. */
export function _resetProcessEnvOverridesForTests(next: ProcessEnvByKind = {}): void {
  overrides = { ...next };
}
