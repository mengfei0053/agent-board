/** Process-level proxy overrides for agent child processes (meta.proxy_env). */
import { getPool } from "./db.js";

export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
] as const;

export type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];

const META_KEY = "proxy_env";

/** In-memory overrides (only non-empty values). */
let overrides: Partial<Record<ProxyEnvKey, string>> = {};

function isKey(k: string): k is ProxyEnvKey {
  return (PROXY_ENV_KEYS as readonly string[]).includes(k);
}

function normalize(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function parseStored(raw: string | null | undefined): Partial<Record<ProxyEnvKey, string>> {
  if (!raw?.trim()) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<ProxyEnvKey, string>> = {};
    for (const k of PROXY_ENV_KEYS) {
      const v = normalize(obj[k]);
      if (v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadProxyEnvOverrides(): Promise<void> {
  const p = getPool();
  const res = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [META_KEY],
  );
  overrides = parseStored(res.rows[0]?.value);
}

/**
 * Env for agent child processes: board `process.env` + optional extras,
 * then non-empty proxy overrides. Empty override → leave process.env as-is
 * (do not strip parent proxies). Also mirrors lowercase keys when injecting
 * (http_proxy / https_proxy / no_proxy / all_proxy) for CLI compatibility.
 */
export function childProcessEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  const injected: string[] = [];
  for (const key of PROXY_ENV_KEYS) {
    const v = overrides[key]?.trim();
    if (!v) continue;
    env[key] = v;
    env[key.toLowerCase()] = v;
    injected.push(key);
  }
  // Stash for spawn log (keys only) — callers may read via lastInjectedProxyKeys
  lastInjectedProxyKeys = injected;
  return env;
}

/** Keys injected on the most recent childProcessEnv() call (no values). */
export let lastInjectedProxyKeys: string[] = [];

export type ProxyEnvSetting = {
  override: string;
  /** Value the child would see after merge (override or inherited). */
  effective: string;
  /** True when effective comes from board process.env, not our override. */
  inherited: boolean;
};

export function getProxyEnvSettings(): {
  proxyEnv: Record<ProxyEnvKey, ProxyEnvSetting>;
} {
  const proxyEnv = {} as Record<ProxyEnvKey, ProxyEnvSetting>;
  for (const k of PROXY_ENV_KEYS) {
    const override = overrides[k] || "";
    const inheritedVal = (process.env[k] || process.env[k.toLowerCase()] || "").trim();
    if (override) {
      proxyEnv[k] = { override, effective: override, inherited: false };
    } else {
      proxyEnv[k] = {
        override: "",
        effective: inheritedVal,
        inherited: Boolean(inheritedVal),
      };
    }
  }
  return { proxyEnv };
}

export async function setProxyEnvOverrides(
  input: Partial<Record<ProxyEnvKey, string>>,
): Promise<ReturnType<typeof getProxyEnvSettings>> {
  const next: Partial<Record<ProxyEnvKey, string>> = { ...overrides };
  for (const [rawKey, rawVal] of Object.entries(input)) {
    if (!isKey(rawKey)) continue;
    const v = normalize(rawVal);
    if (v) next[rawKey] = v;
    else delete next[rawKey];
  }
  overrides = next;
  const p = getPool();
  const payload = JSON.stringify(
    Object.fromEntries(
      PROXY_ENV_KEYS.filter((k) => next[k]).map((k) => [k, next[k]!]),
    ),
  );
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, payload],
  );
  return getProxyEnvSettings();
}

export async function clearProxyEnvOverrides(): Promise<ReturnType<typeof getProxyEnvSettings>> {
  overrides = {};
  const p = getPool();
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, "{}"],
  );
  return getProxyEnvSettings();
}
