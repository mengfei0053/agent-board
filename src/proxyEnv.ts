/** Per-agent proxy overrides for child processes (meta.proxy_env). */
import { getPool } from "./db.js";
import {
  CLI_COMMAND_KEYS,
  type CliCommandKey,
} from "./cliPaths.js";

export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
] as const;

export type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];

/** Per-kind map of non-empty proxy overrides. */
export type ProxyEnvByKind = Partial<
  Record<CliCommandKey, Partial<Record<ProxyEnvKey, string>>>
>;

const META_KEY = "proxy_env";

/** In-memory overrides (only non-empty values), keyed by agent kind. */
let overrides: ProxyEnvByKind = {};

function isProxyKey(k: string): k is ProxyEnvKey {
  return (PROXY_ENV_KEYS as readonly string[]).includes(k);
}

function isKind(k: string): k is CliCommandKey {
  return (CLI_COMMAND_KEYS as readonly string[]).includes(k);
}

function normalize(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function emptyKindMap(): Partial<Record<ProxyEnvKey, string>> {
  return {};
}

/** Parse one kind's flat proxy object into non-empty overrides. */
function parseKindFlat(raw: unknown): Partial<Record<ProxyEnvKey, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyKindMap();
  const out: Partial<Record<ProxyEnvKey, string>> = {};
  for (const k of PROXY_ENV_KEYS) {
    const v = normalize((raw as Record<string, unknown>)[k]);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Detect legacy global shape `{ HTTP_PROXY: "..." }` vs per-kind
 * `{ pi: { HTTP_PROXY: "..." }, ... }`.
 */
function isLegacyFlat(obj: Record<string, unknown>): boolean {
  for (const k of CLI_COMMAND_KEYS) {
    if (
      k in obj &&
      obj[k] != null &&
      typeof obj[k] === "object" &&
      !Array.isArray(obj[k])
    ) {
      return false;
    }
  }
  for (const k of PROXY_ENV_KEYS) {
    if (k in obj && typeof obj[k] === "string") return true;
  }
  return false;
}

/** Pure parse of meta.proxy_env JSON (exported for tests). */
export function parseProxyEnvJson(raw: string | null | undefined): {
  byKind: ProxyEnvByKind;
  migratedFromLegacy: boolean;
} {
  if (!raw?.trim()) return { byKind: {}, migratedFromLegacy: false };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (isLegacyFlat(obj)) {
      const flat = parseKindFlat(obj);
      const byKind: ProxyEnvByKind = {};
      if (Object.keys(flat).length) {
        for (const kind of CLI_COMMAND_KEYS) {
          byKind[kind] = { ...flat };
        }
      }
      return { byKind, migratedFromLegacy: true };
    }
    const byKind: ProxyEnvByKind = {};
    for (const kind of CLI_COMMAND_KEYS) {
      if (!(kind in obj)) continue;
      const parsed = parseKindFlat(obj[kind]);
      if (Object.keys(parsed).length) byKind[kind] = parsed;
    }
    return { byKind, migratedFromLegacy: false };
  } catch {
    return { byKind: {}, migratedFromLegacy: false };
  }
}

function serialize(byKind: ProxyEnvByKind): string {
  const out: Record<string, Record<string, string>> = {};
  for (const kind of CLI_COMMAND_KEYS) {
    const m = byKind[kind];
    if (!m) continue;
    const flat: Record<string, string> = {};
    for (const k of PROXY_ENV_KEYS) {
      if (m[k]) flat[k] = m[k]!;
    }
    if (Object.keys(flat).length) out[kind] = flat;
  }
  return JSON.stringify(out);
}

async function persist(byKind: ProxyEnvByKind): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, serialize(byKind)],
  );
}

export async function loadProxyEnvOverrides(): Promise<void> {
  const p = getPool();
  const res = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [META_KEY],
  );
  const { byKind, migratedFromLegacy } = parseProxyEnvJson(res.rows[0]?.value);
  overrides = byKind;
  // One-shot rewrite so meta.proxy_env is always per-kind going forward.
  if (migratedFromLegacy) {
    await persist(overrides);
  }
}

/**
 * Names copied from the board process into an agent child.
 * Database URLs, webhook secrets, and other service credentials are not included.
 */
const CHILD_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "SSH_AUTH_SOCK",
  "TERM",
  "COLORTERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "PNPM_HOME",
  "NPM_CONFIG_PREFIX",
  "BUN_INSTALL",
  "VOLTA_HOME",
  "ASDF_DIR",
  "NVM_DIR",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
] as const;

const CHILD_ENV_DENY = /^(DATABASE_URL|AGENT_BOARD_WEBHOOK_SECRET|POSTGRES_PASSWORD|PGPASSWORD)$/i;

/** Hide user:password in proxy URLs returned by the settings API. */
export function redactProxyCredential(value: string): string {
  return value.replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, "//$1:***@");
}

/**
 * Env for agent child processes: an allowlist from the board environment,
 * plus optional extras, then non-empty proxy overrides **for that kind**.
 * Empty override leaves the allowlisted inherited value. Also mirrors
 * lowercase keys when injecting.
 */
export function childProcessEnv(
  kind: CliCommandKey,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOW) {
    if (CHILD_ENV_DENY.test(key)) continue;
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (CHILD_ENV_DENY.test(k)) continue;
    if (v !== undefined) env[k] = v;
  }
  const injected: string[] = [];
  const kindMap = overrides[kind] || {};
  for (const key of PROXY_ENV_KEYS) {
    const v = kindMap[key]?.trim();
    if (!v) continue;
    env[key] = v;
    env[key.toLowerCase()] = v;
    injected.push(key);
  }
  lastInjectedProxyKeys = injected;
  lastInjectedProxyKind = kind;
  return env;
}

/** Keys injected on the most recent childProcessEnv() call (no values). */
export let lastInjectedProxyKeys: string[] = [];
/** Kind used on the most recent childProcessEnv() call. */
export let lastInjectedProxyKind: CliCommandKey | null = null;

export type ProxyEnvSetting = {
  override: string;
  /** Value the child would see after merge (override or inherited). */
  effective: string;
  /** True when effective comes from board process.env, not our override. */
  inherited: boolean;
};

export function getProxyEnvSettings(): {
  proxyEnv: Record<CliCommandKey, Record<ProxyEnvKey, ProxyEnvSetting>>;
} {
  const proxyEnv = {} as Record<
    CliCommandKey,
    Record<ProxyEnvKey, ProxyEnvSetting>
  >;
  for (const kind of CLI_COMMAND_KEYS) {
    const kindMap = overrides[kind] || {};
    const row = {} as Record<ProxyEnvKey, ProxyEnvSetting>;
    for (const k of PROXY_ENV_KEYS) {
      const override = kindMap[k] || "";
      const inheritedVal = (
        process.env[k] ||
        process.env[k.toLowerCase()] ||
        ""
      ).trim();
      if (override) {
        const shown = redactProxyCredential(override);
        row[k] = { override: shown, effective: shown, inherited: false };
      } else {
        const shown = redactProxyCredential(inheritedVal);
        row[k] = {
          override: "",
          effective: shown,
          inherited: Boolean(inheritedVal),
        };
      }
    }
    proxyEnv[kind] = row;
  }
  return { proxyEnv };
}

/**
 * Patch per-kind proxy overrides. `input[kind][KEY]=""` clears that key for
 * the kind; omitting a kind leaves it unchanged.
 */
export async function setProxyEnvOverrides(
  input: Partial<Record<CliCommandKey, Partial<Record<ProxyEnvKey, string>>>>,
): Promise<ReturnType<typeof getProxyEnvSettings>> {
  const next: ProxyEnvByKind = { ...overrides };
  for (const [rawKind, rawMap] of Object.entries(input)) {
    if (!isKind(rawKind)) continue;
    if (rawMap == null || typeof rawMap !== "object" || Array.isArray(rawMap)) {
      continue;
    }
    const kindNext: Partial<Record<ProxyEnvKey, string>> = {
      ...(next[rawKind] || {}),
    };
    for (const [rawKey, rawVal] of Object.entries(rawMap)) {
      if (!isProxyKey(rawKey)) continue;
      const v = normalize(rawVal);
      if (v) kindNext[rawKey] = v;
      else delete kindNext[rawKey];
    }
    if (Object.keys(kindNext).length) next[rawKind] = kindNext;
    else delete next[rawKind];
  }
  await persist(next);
  overrides = next;
  return getProxyEnvSettings();
}

/** Pure next-state for an atomic settings write. Does not touch memory or DB. */
export function planProxyEnvOverrides(
  input: Partial<Record<CliCommandKey, Partial<Record<ProxyEnvKey, string>>>>,
): { next: ProxyEnvByKind; json: string } {
  const next: ProxyEnvByKind = { ...overrides };
  for (const [rawKind, rawMap] of Object.entries(input)) {
    if (!isKind(rawKind)) continue;
    if (rawMap == null || typeof rawMap !== "object" || Array.isArray(rawMap)) {
      continue;
    }
    const kindNext: Partial<Record<ProxyEnvKey, string>> = {
      ...(next[rawKind] || {}),
    };
    for (const [rawKey, rawVal] of Object.entries(rawMap)) {
      if (!isProxyKey(rawKey)) continue;
      const v = normalize(rawVal);
      if (v) kindNext[rawKey] = v;
      else delete kindNext[rawKey];
    }
    if (Object.keys(kindNext).length) next[rawKind] = kindNext;
    else delete next[rawKind];
  }
  return { next, json: serialize(next) };
}

export function applyProxyEnvMemory(next: ProxyEnvByKind): void {
  overrides = next;
}

export async function clearProxyEnvOverrides(): Promise<
  ReturnType<typeof getProxyEnvSettings>
> {
  await persist({});
  overrides = {};
  return getProxyEnvSettings();
}

/** @internal test helper — does not persist. */
export function _resetProxyEnvOverridesForTests(next: ProxyEnvByKind = {}): void {
  overrides = { ...next };
  lastInjectedProxyKeys = [];
  lastInjectedProxyKind = null;
}
