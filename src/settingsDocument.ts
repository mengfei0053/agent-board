import {
  CLI_COMMAND_KEYS,
  applyCliPathMemory,
  getCliPathSettingsResolved,
  planCliPathOverrides,
  type CliCommandKey,
} from "./cliPaths.js";
import { applyCodexSandboxMemory, getCodexSandboxSettings, planCodexSandbox } from "./codexSandbox.js";
import { upsertMetaMany } from "./db.js";
import { HttpError, httpStatusOf } from "./httpError.js";
import { getProxyEnvSettings, planProxyEnvOverrides, applyProxyEnvMemory, PROXY_ENV_KEYS, type ProxyEnvKey } from "./proxyEnv.js";
import { applyQuickPromptsMemory, getQuickPromptSettings, planQuickPrompts } from "./quickPrompts.js";
import { withSettingsLock } from "./settingsLock.js";

export type SettingsDocument = Awaited<ReturnType<typeof readSettingsDocument>>;

type MetaUpsert = (entries: ReadonlyArray<readonly [string, string]>) => Promise<void>;

let metaUpsert: MetaUpsert = upsertMetaMany;

/** Unit tests skip Postgres. Production uses `upsertMetaMany`. */
export function setSettingsMetaUpsertForTests(fn: MetaUpsert | null): void {
  metaUpsert = fn ?? upsertMetaMany;
}

/** Same document as `GET /api/settings`, including redacted proxy userinfo. */
export async function readSettingsDocument(): Promise<{
  cliPaths: Awaited<ReturnType<typeof getCliPathSettingsResolved>>["cliPaths"];
  proxyEnv: ReturnType<typeof getProxyEnvSettings>["proxyEnv"];
  quickPrompts: ReturnType<typeof getQuickPromptSettings>["quickPrompts"];
  codexSandbox: boolean;
}> {
  return {
    ...(await getCliPathSettingsResolved()),
    ...getProxyEnvSettings(),
    ...getQuickPromptSettings(),
    ...getCodexSandboxSettings(),
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
        ["codex_sandbox", "true"],
      ]);
    } catch {
      throw new HttpError(500, "settings write failed");
    }
    applyCliPathMemory({});
    applyProxyEnvMemory({});
    applyCodexSandboxMemory(true);
    return readSettingsDocument();
  }

  const hasCli = raw.cliPaths != null;
  const hasProxy = raw.proxyEnv != null;
  const hasQuick = raw.quickPrompts != null;
  const hasCodexSandbox = raw.codexSandbox != null;
  if (!hasCli && !hasProxy && !hasQuick && !hasCodexSandbox) {
    throw new HttpError(400, "cliPaths, proxyEnv, quickPrompts, and/or codexSandbox required (or clear: true)");
  }

  let cliPlan: ReturnType<typeof planCliPathOverrides> | undefined;
  let proxyPlan: ReturnType<typeof planProxyEnvOverrides> | undefined;

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
    if (hasQuick) quickPlan = planQuickPrompts(raw.quickPrompts);
    if (hasCodexSandbox) codexPlan = planCodexSandbox(raw.codexSandbox);
  } catch (err) {
    throw settingsValidationError(err);
  }

  const entries: Array<readonly [string, string]> = [];
  if (cliPlan) entries.push(["cli_paths", cliPlan.json]);
  if (proxyPlan) entries.push(["proxy_env", proxyPlan.json]);
  if (quickPlan) entries.push(["quick_prompts", quickPlan.json]);
  if (codexPlan) entries.push(["codex_sandbox", codexPlan.json]);
  try {
    await metaUpsert(entries);
  } catch {
    throw new HttpError(500, "settings write failed");
  }
  if (cliPlan) applyCliPathMemory(cliPlan.next);
  if (proxyPlan) applyProxyEnvMemory(proxyPlan.next);
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
