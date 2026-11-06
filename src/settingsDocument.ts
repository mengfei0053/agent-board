import {
  AGENT_KINDS,
  CLAUDE_DEFAULT_EFFORTS,
  normalizeAgentModelRecords,
  PI_THINKING_EFFORTS,
  readAgentModels,
  type AgentModelRecord,
  type AgentModelsByKind,
} from "./agentModels.js";
import {
  CLI_COMMAND_KEYS,
  applyCliPathMemory,
  getCliPathSettingsResolved,
  planCliPathOverrides,
  type CliCommandKey,
} from "./cliPaths.js";
import { applyCodexSandboxMemory, getCodexSandboxSettings, planCodexSandbox } from "./codexSandbox.js";
import { hasPool, upsertMetaMany } from "./db.js";
import { HttpError, httpStatusOf } from "./httpError.js";
import { MAX_MODEL_CHARS } from "./limits.js";
import { MODEL_HISTORY_LIMIT, readModelHistory } from "./modelHistory.js";
import { getProxyEnvSettings, planProxyEnvOverrides, applyProxyEnvMemory, PROXY_ENV_KEYS, type ProxyEnvKey } from "./proxyEnv.js";
import {
  applyProcessEnvMemory,
  getProcessEnvSettings,
  planProcessEnvOverrides,
} from "./processEnv.js";
import { applyQuickPromptsMemory, getQuickPromptSettings, planQuickPrompts } from "./quickPrompts.js";
import { withSettingsLock } from "./settingsLock.js";
import type { AgentKind } from "./types.js";

export type SettingsDocument = Awaited<ReturnType<typeof readSettingsDocument>>;

export type ThinkingEffortsByKind = Record<AgentKind, string[]>;
export type ModelHistoryByKind = Record<AgentKind, string[]>;

export const DEFAULT_THINKING_EFFORTS_BY_KIND: Record<AgentKind, readonly string[]> = {
  pi: PI_THINKING_EFFORTS,
  claude: CLAUDE_DEFAULT_EFFORTS,
  cursor: CLAUDE_DEFAULT_EFFORTS,
  devin: CLAUDE_DEFAULT_EFFORTS,
  codex: CLAUDE_DEFAULT_EFFORTS,
  kimi: [],
};

const CANONICAL_EFFORTS = [
  "none",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const MAX_SETTINGS_MODELS_PER_KIND = 500;

type MetaUpsert = (entries: ReadonlyArray<readonly [string, string]>) => Promise<void>;

type ModelCatalogOverride = {
  agentModels?: Partial<Record<AgentKind, readonly AgentModelRecord[]>>;
  modelHistory?: Partial<Record<AgentKind, readonly string[]>>;
};

let metaUpsert: MetaUpsert = upsertMetaMany;
let modelCatalogOverride: ModelCatalogOverride | null = null;

/** Unit tests skip Postgres. Production uses `upsertMetaMany`. */
export function setSettingsMetaUpsertForTests(fn: MetaUpsert | null): void {
  metaUpsert = fn ?? upsertMetaMany;
}

/** Unit tests can inject model catalogs without touching Postgres. */
export function setSettingsModelCatalogForTests(override: ModelCatalogOverride | null): void {
  modelCatalogOverride = override;
}

function sanitizeModelId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, "//$1:***@")
    .trim();
  if (!cleaned || cleaned.length > MAX_MODEL_CHARS) return "";
  return cleaned;
}

function sanitizeEffort(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase();
  if (!cleaned || cleaned.length > 32) return "";
  return cleaned;
}

function sanitizeAgentModels(raw: Partial<Record<AgentKind, readonly AgentModelRecord[]>> | undefined): AgentModelsByKind {
  const out: AgentModelsByKind = { pi: [], claude: [], cursor: [], devin: [], codex: [], kimi: [] };
  if (!raw || typeof raw !== "object") return out;
  for (const kind of AGENT_KINDS) {
    const records = Array.isArray(raw[kind]) ? raw[kind] : [];
    const safeRecords: AgentModelRecord[] = [];
    for (const rec of records) {
      const model = sanitizeModelId(rec?.model);
      if (!model) continue;
      const efforts = Array.isArray(rec?.thinkingEfforts)
        ? rec.thinkingEfforts.map(sanitizeEffort).filter(Boolean)
        : [];
      safeRecords.push({ model, thinkingEfforts: efforts });
    }
    out[kind] = normalizeAgentModelRecords(safeRecords).slice(0, MAX_SETTINGS_MODELS_PER_KIND);
  }
  return out;
}

function buildThinkingEffortsByKind(agentModels: AgentModelsByKind): ThinkingEffortsByKind {
  const out: ThinkingEffortsByKind = { pi: [], claude: [], cursor: [], devin: [], codex: [], kimi: [] };
  for (const kind of AGENT_KINDS) {
    const seen = new Set<string>();
    for (const item of agentModels[kind]) {
      for (const effort of item.thinkingEfforts) {
        const clean = sanitizeEffort(effort);
        if (clean) seen.add(clean);
      }
    }
    if (seen.size > 0) {
      const ordered: string[] = [];
      for (const known of CANONICAL_EFFORTS) {
        if (seen.has(known)) {
          ordered.push(known);
          seen.delete(known);
        }
      }
      for (const rest of seen) ordered.push(rest);
      out[kind] = ordered;
    } else {
      out[kind] = [...DEFAULT_THINKING_EFFORTS_BY_KIND[kind]];
    }
  }
  return out;
}

function sanitizeModelHistory(raw: Partial<Record<AgentKind, readonly string[]>> | undefined): ModelHistoryByKind {
  const out: ModelHistoryByKind = { pi: [], claude: [], cursor: [], devin: [], codex: [], kimi: [] };
  if (!raw || typeof raw !== "object") return out;
  for (const kind of AGENT_KINDS) {
    const list = Array.isArray(raw[kind]) ? raw[kind] : [];
    const seen = new Set<string>();
    for (const item of list) {
      const model = sanitizeModelId(item);
      if (!model || seen.has(model)) continue;
      seen.add(model);
      out[kind].push(model);
      if (out[kind].length >= MODEL_HISTORY_LIMIT) break;
    }
  }
  return out;
}

async function readModelCatalogForSettings(): Promise<{
  agentModels: AgentModelsByKind;
  thinkingEfforts: ThinkingEffortsByKind;
  modelHistory: ModelHistoryByKind;
}> {
  if (modelCatalogOverride) {
    const agentModels = sanitizeAgentModels(modelCatalogOverride.agentModels);
    return {
      agentModels,
      thinkingEfforts: buildThinkingEffortsByKind(agentModels),
      modelHistory: sanitizeModelHistory(modelCatalogOverride.modelHistory),
    };
  }
  if (!hasPool() || metaUpsert !== upsertMetaMany) {
    const agentModels = sanitizeAgentModels(undefined);
    return {
      agentModels,
      thinkingEfforts: buildThinkingEffortsByKind(agentModels),
      modelHistory: sanitizeModelHistory(undefined),
    };
  }
  const [rawModels, rawHistory] = await Promise.all([
    readAgentModels().catch(() => undefined),
    readModelHistory().catch(() => undefined),
  ]);
  const agentModels = sanitizeAgentModels(rawModels);
  return {
    agentModels,
    thinkingEfforts: buildThinkingEffortsByKind(agentModels),
    modelHistory: sanitizeModelHistory(rawHistory),
  };
}

/** Same document as `GET /api/settings`, including redacted proxy userinfo. */
export async function readSettingsDocument(): Promise<{
  cliPaths: Awaited<ReturnType<typeof getCliPathSettingsResolved>>["cliPaths"];
  proxyEnv: ReturnType<typeof getProxyEnvSettings>["proxyEnv"];
  processEnv: ReturnType<typeof getProcessEnvSettings>["processEnv"];
  quickPrompts: ReturnType<typeof getQuickPromptSettings>["quickPrompts"];
  codexSandbox: boolean;
  agentModels: AgentModelsByKind;
  thinkingEfforts: ThinkingEffortsByKind;
  modelHistory: ModelHistoryByKind;
}> {
  const [cliPaths, catalog] = await Promise.all([
    getCliPathSettingsResolved(),
    readModelCatalogForSettings(),
  ]);
  return {
    ...cliPaths,
    ...getProxyEnvSettings(),
    ...getProcessEnvSettings(),
    ...getQuickPromptSettings(),
    ...getCodexSandboxSettings(),
    ...catalog,
  };
}

export type WriteSettingsOptions = {
  /**
   * HTTP `PUT /api/settings` allows `clear: true` (reset CLI paths, proxies, and sandbox;
   * keep quick prompts). `cmd.settings.put` must pass `false`.
   */
  allowClear: boolean;
};

/**
 * The only settings write. HTTP PUT and `cmd.settings.put` both call this under
 * `withSettingsLock`. Proxy placeholders keep the stored secret. Returned documents
 * are the redacted GET shape. Failures never include the submitted proxy value.
 */
export function writeSettingsDocument(
  raw: Record<string, unknown>,
  opts: WriteSettingsOptions,
): Promise<SettingsDocument> {
  return withSettingsLock(() => writeSettingsBody(raw, opts));
}

async function writeSettingsBody(
  raw: Record<string, unknown>,
  opts: WriteSettingsOptions,
): Promise<SettingsDocument> {
  if ("clear" in raw && raw.clear != null && typeof raw.clear !== "boolean") {
    throw new HttpError(400, "clear must be a boolean");
  }
  if (raw.clear === true) {
    if (!opts.allowClear) throw new HttpError(400, "clear is not allowed");
    try {
      await metaUpsert([
        ["cli_paths", "{}"],
        ["proxy_env", "{}"],
        ["process_env", "{}"],
        ["codex_sandbox", "true"],
      ]);
    } catch {
      throw new HttpError(500, "settings write failed");
    }
    applyCliPathMemory({});
    applyProxyEnvMemory({});
    applyProcessEnvMemory({});
    applyCodexSandboxMemory(true);
    return readSettingsDocument();
  }

  const hasCli = raw.cliPaths != null;
  const hasProxy = raw.proxyEnv != null;
  const hasProcessEnv = raw.processEnv != null;
  const hasQuick = raw.quickPrompts != null;
  const hasCodexSandbox = raw.codexSandbox != null;
  if (!hasCli && !hasProxy && !hasProcessEnv && !hasQuick && !hasCodexSandbox) {
    throw new HttpError(400, "cliPaths, proxyEnv, processEnv, quickPrompts, and/or codexSandbox required (or clear: true)");
  }

  let cliPlan: ReturnType<typeof planCliPathOverrides> | undefined;
  let proxyPlan: ReturnType<typeof planProxyEnvOverrides> | undefined;
  let processPlan: ReturnType<typeof planProcessEnvOverrides> | undefined;

  if (hasCli) {
    if (typeof raw.cliPaths !== "object" || Array.isArray(raw.cliPaths)) {
      throw new HttpError(400, "cliPaths must be an object");
    }
    const patch: Partial<Record<CliCommandKey, string>> = {};
    for (const [k, v] of Object.entries(raw.cliPaths as Record<string, unknown>)) {
      if (!(CLI_COMMAND_KEYS as readonly string[]).includes(k)) {
        throw new HttpError(400, `unknown cliPaths key: ${k}`);
      }
      if (v != null && typeof v !== "string") {
        throw new HttpError(400, `cliPaths.${k} must be a string`);
      }
      patch[k as CliCommandKey] = typeof v === "string" ? v : "";
    }
    cliPlan = planCliPathOverrides(patch);
  }

  if (hasProxy) {
    if (typeof raw.proxyEnv !== "object" || Array.isArray(raw.proxyEnv)) {
      throw new HttpError(400, "proxyEnv must be an object");
    }
    const patch: Partial<Record<CliCommandKey, Partial<Record<ProxyEnvKey, string>>>> = {};
    for (const [kind, kindVal] of Object.entries(raw.proxyEnv as Record<string, unknown>)) {
      if (!(CLI_COMMAND_KEYS as readonly string[]).includes(kind)) {
        throw new HttpError(400, `unknown proxyEnv kind: ${kind}`);
      }
      if (kindVal == null || typeof kindVal !== "object" || Array.isArray(kindVal)) {
        throw new HttpError(400, `proxyEnv.${kind} must be an object`);
      }
      const kindPatch: Partial<Record<ProxyEnvKey, string>> = {};
      for (const [k, v] of Object.entries(kindVal as Record<string, unknown>)) {
        if (!(PROXY_ENV_KEYS as readonly string[]).includes(k)) {
          throw new HttpError(400, `unknown proxyEnv.${kind} key: ${k}`);
        }
        if (v != null && typeof v !== "string") {
          throw new HttpError(400, `proxyEnv.${kind}.${k} must be a string`);
        }
        kindPatch[k as ProxyEnvKey] = typeof v === "string" ? v : "";
      }
      patch[kind as CliCommandKey] = kindPatch;
    }
    proxyPlan = planProxyEnvOverrides(patch);
  }

  let quickPlan: ReturnType<typeof planQuickPrompts> | undefined;
  let codexPlan: ReturnType<typeof planCodexSandbox> | undefined;
  try {
    if (hasProcessEnv) processPlan = planProcessEnvOverrides(raw.processEnv);
    if (hasQuick) quickPlan = planQuickPrompts(raw.quickPrompts);
    if (hasCodexSandbox) codexPlan = planCodexSandbox(raw.codexSandbox);
  } catch (err) {
    throw settingsValidationError(err);
  }

  const entries: Array<readonly [string, string]> = [];
  if (cliPlan) entries.push(["cli_paths", cliPlan.json]);
  if (proxyPlan) entries.push(["proxy_env", proxyPlan.json]);
  if (processPlan) entries.push(["process_env", processPlan.json]);
  if (quickPlan) entries.push(["quick_prompts", quickPlan.json]);
  if (codexPlan) entries.push(["codex_sandbox", codexPlan.json]);
  try {
    await metaUpsert(entries);
  } catch {
    throw new HttpError(500, "settings write failed");
  }
  if (cliPlan) applyCliPathMemory(cliPlan.next);
  if (proxyPlan) applyProxyEnvMemory(proxyPlan.next);
  if (processPlan) applyProcessEnvMemory(processPlan.next);
  if (quickPlan) applyQuickPromptsMemory(quickPlan.next);
  if (codexPlan) applyCodexSandboxMemory(codexPlan.next);
  return readSettingsDocument();
}

function settingsValidationError(err: unknown): HttpError {
  if (err instanceof HttpError && isSafeSettingsMessage(err.message)) return err;
  const msg = err instanceof Error ? err.message : "";
  if (isSafeSettingsMessage(msg)) return new HttpError(httpStatusOf(err, 400), msg);
  return new HttpError(400, "bad request");
}

/** Reject anything that could be a path or a proxy URL with a password. */
export function isSafeSettingsMessage(msg: string): boolean {
  if (!msg || msg.length > 180) return false;
  if (/[\\/@]|:\/\//.test(msg)) return false;
  return /^[\x20-\x7e]+$/.test(msg);
}
