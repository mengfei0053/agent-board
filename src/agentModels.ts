import { spawn } from "node:child_process";
import { resolveCliCommand, type CliCommandKey } from "./cliPaths.js";
import { getPool } from "./db.js";
import { MAX_MODEL_CHARS } from "./limits.js";
import { childProcessEnv } from "./proxyEnv.js";
import { spawnCollect } from "./spawnCollect.js";
import type { AgentKind } from "./types.js";

export const AGENT_KINDS: readonly AgentKind[] = [
  "pi",
  "claude",
  "cursor",
  "devin",
  "codex",
];

export const PI_THINKING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const CLAUDE_DEFAULT_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const KNOWN_EFFORTS_ORDER = [
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

export type AgentModelRecord = {
  model: string;
  thinkingEfforts: string[];
};

export type AgentModelsByKind = Record<AgentKind, AgentModelRecord[]>;

export type AgentModelFetcher = (kind: AgentKind) => Promise<AgentModelRecord[]>;

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
const EFFORT_SUFFIX_RE =
  /^(.*?)-(none|off|minimal|low|medium|high|xhigh|max|ultra)(?:-(?:fast|lightning|priority|1m))*$/i;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function normalizeEfforts(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().toLowerCase();
    if (!trimmed || trimmed.length > 32) continue;
    seen.add(trimmed);
  }
  const ordered: string[] = [];
  for (const known of KNOWN_EFFORTS_ORDER) {
    if (seen.has(known)) {
      ordered.push(known);
      seen.delete(known);
    }
  }
  for (const rest of seen) ordered.push(rest);
  return ordered;
}

export function normalizeAgentModelRecords(
  records: readonly AgentModelRecord[],
): AgentModelRecord[] {
  const byModel = new Map<string, Set<string>>();
  for (const rec of records) {
    const model = typeof rec?.model === "string" ? rec.model.trim() : "";
    if (!model || model.length > MAX_MODEL_CHARS || model.includes("\0")) continue;
    let efforts = byModel.get(model);
    if (!efforts) {
      efforts = new Set<string>();
      byModel.set(model, efforts);
    }
    for (const e of normalizeEfforts(rec.thinkingEfforts || [])) {
      efforts.add(e);
    }
  }
  const out: AgentModelRecord[] = [];
  for (const [model, efforts] of byModel.entries()) {
    out.push({
      model,
      thinkingEfforts: normalizeEfforts([...efforts]),
    });
  }
  return out;
}

function extractObjectModelId(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function extractDirectModelsList(parsed: Record<string, unknown> | unknown[]): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  const controlModels = (
    (parsed.response as Record<string, unknown> | undefined)?.response as
      | Record<string, unknown>
      | undefined
  )?.models;
  if (Array.isArray(controlModels)) return controlModels;
  if (Array.isArray(parsed.models)) return parsed.models;
  if (Array.isArray(parsed.data)) return parsed.data;
  return null;
}

/** Parse `pi --list-models` table output (or JSON array/object). */
export function parsePiModelsOutput(stdout: string): AgentModelRecord[] {
  const cleaned = stripAnsi(stdout || "").trim();
  if (!cleaned) return [];
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown> | unknown[];
      const list = extractDirectModelsList(parsed) || [];
      const records: AgentModelRecord[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const provider = extractObjectModelId(obj, ["provider"]);
        const id = extractObjectModelId(obj, ["id", "model"]);
        if (!id) continue;
        const model = provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
        let efforts: string[] = [];
        if (Array.isArray(obj.thinkingEfforts)) {
          efforts = normalizeEfforts(obj.thinkingEfforts);
        } else if (obj.reasoning === true) {
          efforts = [...PI_THINKING_EFFORTS];
        }
        records.push({ model, thinkingEfforts: efforts });
      }
      return normalizeAgentModelRecords(records);
    } catch {
      /* fall through to line parser */
    }
  }

  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const records: AgentModelRecord[] = [];
  for (const line of lines) {
    if (/^(warning:|no models|tip:)/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (
      cols[0]?.toLowerCase() === "provider" &&
      cols[1]?.toLowerCase() === "model"
    ) {
      continue;
    }
    if (cols.length >= 5) {
      const [provider, modelId, , , thinkingCol] = cols;
      if (!provider || !modelId) continue;
      const model = modelId.startsWith(`${provider}/`)
        ? modelId
        : `${provider}/${modelId}`;
      const lowerThinking = (thinkingCol || "").toLowerCase();
      let thinkingEfforts: string[] = [];
      if (lowerThinking === "yes" || lowerThinking === "true") {
        thinkingEfforts = [...PI_THINKING_EFFORTS];
      } else if (lowerThinking !== "no" && lowerThinking !== "false") {
        thinkingEfforts = normalizeEfforts(lowerThinking.split(","));
      }
      records.push({ model, thinkingEfforts });
    } else if (cols.length === 1 && /^[A-Za-z0-9._:/@-]+$/.test(cols[0]!)) {
      records.push({ model: cols[0]!, thinkingEfforts: [] });
    }
  }
  return normalizeAgentModelRecords(records);
}

/** Parse `claude` control_response initialize output (or JSON / line output). */
export function parseClaudeModelsOutput(stdout: string): AgentModelRecord[] {
  const cleaned = stripAnsi(stdout || "").trim();
  if (!cleaned) return [];
  const records: AgentModelRecord[] = [];

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown> | unknown[];
      const directModels = extractDirectModelsList(parsed);
      if (!directModels) continue;
      for (const item of directModels) {
        if (typeof item === "string" && item.trim()) {
          records.push({ model: item.trim(), thinkingEfforts: [...CLAUDE_DEFAULT_EFFORTS] });
          continue;
        }
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        let efforts: string[] = [];
        if (Array.isArray(obj.supportedEffortLevels)) {
          efforts = normalizeEfforts(obj.supportedEffortLevels);
        } else if (Array.isArray(obj.thinkingEfforts)) {
          efforts = normalizeEfforts(obj.thinkingEfforts);
        } else if (obj.supportsEffort === true) {
          efforts = [...CLAUDE_DEFAULT_EFFORTS];
        }
        const value = extractObjectModelId(obj, ["value"]);
        const resolved = extractObjectModelId(obj, ["resolvedModel"]);
        const id = extractObjectModelId(obj, ["id", "model"]);
        if (value && value !== "default") {
          records.push({ model: value, thinkingEfforts: efforts });
        }
        if (resolved) {
          records.push({ model: resolved, thinkingEfforts: efforts });
        }
        if (id && id !== "default") {
          records.push({ model: id, thinkingEfforts: efforts });
        }
      }
    } catch {
      /* ignore non-json line */
    }
  }
  if (records.length) return normalizeAgentModelRecords(records);

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(available models|tip:|error:|warning:)/i.test(line)) continue;
    const dashMatch = /^([A-Za-z0-9._:/@-]+)\s+-\s+/.exec(line);
    if (dashMatch?.[1]) {
      records.push({ model: dashMatch[1], thinkingEfforts: [...CLAUDE_DEFAULT_EFFORTS] });
    } else if (/^[A-Za-z0-9._:/@-]+$/.test(line)) {
      records.push({ model: line, thinkingEfforts: [...CLAUDE_DEFAULT_EFFORTS] });
    }
  }
  return normalizeAgentModelRecords(records);
}

/** Parse `agent --list-models` output for Cursor CLI. */
export function parseCursorModelsOutput(stdout: string): AgentModelRecord[] {
  const cleaned = stripAnsi(stdout || "").trim();
  if (!cleaned) return [];

  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown> | unknown[];
      const list = extractDirectModelsList(parsed) || [];
      const records: AgentModelRecord[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const id = extractObjectModelId(obj, ["id", "model", "modelId"]);
        if (!id) continue;
        const efforts = Array.isArray(obj.thinkingEfforts)
          ? normalizeEfforts(obj.thinkingEfforts)
          : [];
        records.push({ model: id, thinkingEfforts: efforts });
      }
      if (records.length) return normalizeAgentModelRecords(records);
    } catch {
      /* fall through */
    }
  }

  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rawModels: string[] = [];
  const familyEfforts = new Map<string, Set<string>>();

  for (const line of lines) {
    if (/^(available models|tip:|no models|error:|authentication)/i.test(line)) continue;
    const m = /^([A-Za-z0-9._:/@-]+)\s+-\s+.+$/.exec(line);
    const modelId = m?.[1]?.trim() || (/^[A-Za-z0-9._:/@-]+$/.test(line) ? line : "");
    if (!modelId) continue;
    rawModels.push(modelId);
    const suffixMatch = EFFORT_SUFFIX_RE.exec(modelId);
    if (suffixMatch?.[1] && suffixMatch[2]) {
      const base = suffixMatch[1];
      const effort = suffixMatch[2].toLowerCase();
      const set = familyEfforts.get(base) ?? new Set<string>();
      set.add(effort);
      familyEfforts.set(base, set);
    }
  }

  const records: AgentModelRecord[] = [];
  for (const modelId of rawModels) {
    const suffixMatch = EFFORT_SUFFIX_RE.exec(modelId);
    if (suffixMatch?.[2]) {
      records.push({
        model: modelId,
        thinkingEfforts: [suffixMatch[2].toLowerCase()],
      });
    } else {
      const fam = familyEfforts.get(modelId);
      records.push({
        model: modelId,
        thinkingEfforts: fam ? normalizeEfforts([...fam]) : [],
      });
    }
  }
  return normalizeAgentModelRecords(records);
}

/** Parse `devin models list --format json` (or text output). */
export function parseDevinModelsOutput(stdout: string): AgentModelRecord[] {
  const cleaned = stripAnsi(stdout || "").trim();
  if (!cleaned) return [];

  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      const families = Array.isArray(parsed.families) ? parsed.families : null;
      if (families) {
        const records: AgentModelRecord[] = [];
        for (const fam of families) {
          if (!fam || typeof fam !== "object") continue;
          const famObj = fam as Record<string, unknown>;
          const slug = typeof famObj.slug === "string" ? famObj.slug.trim() : "";
          const variants = Array.isArray(famObj.variants) ? famObj.variants : [];
          // Skip auto-generated combinatoric fusion sidekick variants unless it's the family slug
          if (slug === "fusion") continue;
          const famEfforts = new Set<string>();
          const variantRecords: AgentModelRecord[] = [];
          for (const v of variants) {
            if (!v || typeof v !== "object") continue;
            const vObj = v as Record<string, unknown>;
            const uid = typeof vObj.model_uid === "string" ? vObj.model_uid.trim() : "";
            if (!uid) continue;
            const m = EFFORT_SUFFIX_RE.exec(uid);
            const effort = m?.[2]?.toLowerCase();
            if (effort) famEfforts.add(effort);
            variantRecords.push({
              model: uid,
              thinkingEfforts: effort ? [effort] : [],
            });
          }
          const normalizedFamEfforts = normalizeEfforts([...famEfforts]);
          if (slug) {
            records.push({ model: slug, thinkingEfforts: normalizedFamEfforts });
          }
          for (const vr of variantRecords) {
            records.push({
              model: vr.model,
              thinkingEfforts: vr.thinkingEfforts.length
                ? vr.thinkingEfforts
                : normalizedFamEfforts,
            });
          }
        }
        return normalizeAgentModelRecords(records);
      }
    } catch {
      /* fall through */
    }
  }

  // Fallback text parser for `devin models`
  const records: AgentModelRecord[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(available models|aliases:)/i.test(line)) continue;
    const variantMatch = /^([a-z0-9][a-z0-9._-]*)\s{2,}\S/i.exec(line);
    if (variantMatch?.[1]) {
      const uid = variantMatch[1];
      const m = EFFORT_SUFFIX_RE.exec(uid);
      records.push({
        model: uid,
        thinkingEfforts: m?.[2] ? [m[2].toLowerCase()] : [],
      });
    }
  }
  return normalizeAgentModelRecords(records);
}

/** Parse `codex debug models` JSON output. */
export function parseCodexModelsOutput(stdout: string): AgentModelRecord[] {
  const cleaned = stripAnsi(stdout || "").trim();
  if (!cleaned) return [];

  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown> | unknown[];
      const list = extractDirectModelsList(parsed) || [];
      const records: AgentModelRecord[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        if (obj.visibility === "hide") continue;
        const slug = extractObjectModelId(obj, ["slug", "model", "id"]);
        if (!slug) continue;
        let rawLevels: unknown[] = [];
        if (Array.isArray(obj.supported_reasoning_levels)) {
          rawLevels = obj.supported_reasoning_levels;
        } else if (Array.isArray(obj.thinkingEfforts)) {
          rawLevels = obj.thinkingEfforts;
        }
        const efforts: string[] = [];
        for (const lvl of rawLevels) {
          if (typeof lvl === "string") efforts.push(lvl);
          else if (lvl && typeof lvl === "object" && typeof (lvl as { effort?: unknown }).effort === "string") {
            efforts.push((lvl as { effort: string }).effort);
          }
        }
        if (!efforts.length && typeof obj.default_reasoning_level === "string") {
          efforts.push(obj.default_reasoning_level);
        }
        records.push({
          model: slug,
          thinkingEfforts: normalizeEfforts(efforts),
        });
      }
      return normalizeAgentModelRecords(records);
    } catch {
      /* fall through */
    }
  }

  const records: AgentModelRecord[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(available models|tip:|error:)/i.test(line)) continue;
    if (/^[A-Za-z0-9._:/@-]+$/.test(line)) {
      records.push({ model: line, thinkingEfforts: [] });
    }
  }
  return normalizeAgentModelRecords(records);
}

function probeClaudeInitialize(
  cmd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const cut = () => {
      if (!child) return;
      try { child.stdin?.destroy(); } catch { /* ignore */ }
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.stderr?.destroy(); } catch { /* ignore */ }
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    };
    const finish = (out: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cut();
      resolve(out);
    };
    const timer = setTimeout(() => finish(stdout), timeoutMs);
    timer.unref?.();
    try {
      child = spawn(
        cmd,
        [
          "-p",
          "--bare",
          "--no-session-persistence",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        },
      );
    } catch {
      finish("");
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 2_000_000) {
        stdout += chunk.toString("utf8");
      }
      if (stdout.includes('"control_response"')) {
        finish(stdout);
      }
    });
    child.on("error", () => finish(stdout));
    child.on("close", () => finish(stdout));
    try {
      child.stdin?.write(
        JSON.stringify({
          type: "control_request",
          request_id: "req_1",
          request: { subtype: "initialize" },
        }) + "\n",
      );
      child.stdin?.end();
    } catch {
      finish(stdout);
    }
  });
}

function cliKeyForAgent(kind: AgentKind): CliCommandKey {
  return kind === "cursor" ? "agent" : kind;
}

/** Probe the local CLI for one agent's models and supported thinking efforts. */
export async function fetchAgentModelsFromCli(
  kind: AgentKind,
  timeoutMs = 20_000,
): Promise<AgentModelRecord[]> {
  const cliKey = cliKeyForAgent(kind);
  const cmd = resolveCliCommand(cliKey);
  const env = childProcessEnv(cliKey, { NO_COLOR: "1" });
  const maxBytes = 10_000_000;

  if (kind === "pi") {
    const fast = await spawnCollect(
      cmd,
      [
        "--offline",
        "--no-lens",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--list-models",
      ],
      {
        env: { ...env, PI_OFFLINE: "1" },
        timeoutMs,
        maxBytes,
      },
    );
    if (fast.code === 0 && !fast.timedOut) {
      const parsed = parsePiModelsOutput(fast.stdout);
      if (parsed.length) return parsed;
    }
    const fallback = await spawnCollect(cmd, ["--list-models"], {
      env,
      timeoutMs,
      maxBytes,
    });
    if (fallback.code !== 0 || fallback.timedOut) {
      throw new Error(fallback.stderr.trim() || `pi --list-models exited ${fallback.code}`);
    }
    const parsed = parsePiModelsOutput(fallback.stdout);
    if (!parsed.length) throw new Error("pi returned no models");
    return parsed;
  }

  if (kind === "claude") {
    const controlOut = await probeClaudeInitialize(cmd, env, Math.min(timeoutMs, 10_000));
    const fromControl = parseClaudeModelsOutput(controlOut);
    if (fromControl.length) return fromControl;

    const fallback = await spawnCollect(cmd, ["--list-models"], {
      env,
      timeoutMs: Math.min(timeoutMs, 10_000),
      maxBytes,
    });
    if (fallback.code === 0 && !fallback.timedOut) {
      const parsed = parseClaudeModelsOutput(fallback.stdout);
      if (parsed.length) return parsed;
    }
    throw new Error("claude returned no models");
  }

  if (kind === "cursor") {
    const res = await spawnCollect(cmd, ["--list-models"], {
      env,
      timeoutMs,
      maxBytes,
    });
    if (res.code !== 0 || res.timedOut) {
      throw new Error(res.stderr.trim() || `agent --list-models exited ${res.code}`);
    }
    const parsed = parseCursorModelsOutput(res.stdout);
    if (!parsed.length) throw new Error("cursor agent returned no models");
    return parsed;
  }

  if (kind === "devin") {
    const res = await spawnCollect(cmd, ["models", "list", "--format", "json"], {
      env,
      timeoutMs,
      maxBytes,
    });
    if (res.code === 0 && !res.timedOut) {
      const parsed = parseDevinModelsOutput(res.stdout);
      if (parsed.length) return parsed;
    }
    const fallback = await spawnCollect(cmd, ["models"], {
      env,
      timeoutMs,
      maxBytes,
    });
    if (fallback.code !== 0 || fallback.timedOut) {
      throw new Error(fallback.stderr.trim() || `devin models exited ${fallback.code}`);
    }
    const parsed = parseDevinModelsOutput(fallback.stdout);
    if (!parsed.length) throw new Error("devin returned no models");
    return parsed;
  }

  if (kind === "codex") {
    const res = await spawnCollect(cmd, ["debug", "models"], {
      env,
      timeoutMs,
      maxBytes,
    });
    if (res.code !== 0 || res.timedOut) {
      throw new Error(res.stderr.trim() || `codex debug models exited ${res.code}`);
    }
    const parsed = parseCodexModelsOutput(res.stdout);
    if (!parsed.length) throw new Error("codex returned no models");
    return parsed;
  }

  throw new Error(`unsupported agent kind: ${String(kind)}`);
}

/**
 * Upsert fetched models and their supported thinking efforts for one agent kind.
 * Does not delete or overwrite when `records` is empty.
 */
export async function upsertAgentModelsForKind(
  kind: AgentKind,
  records: readonly AgentModelRecord[],
): Promise<number> {
  if (!AGENT_KINDS.includes(kind)) {
    throw new Error(`invalid agent kind: ${String(kind)}`);
  }
  const normalized = normalizeAgentModelRecords(records);
  if (!normalized.length) return 0;

  const payload = normalized.map((r) => ({
    kind,
    model: r.model,
    thinking_efforts: r.thinkingEfforts,
  }));

  await getPool().query(
    `INSERT INTO agent_models (kind, model, thinking_efforts, updated_at)
     SELECT kind, model, thinking_efforts, NOW()
     FROM jsonb_to_recordset($1::jsonb)
       AS incoming(kind TEXT, model TEXT, thinking_efforts JSONB)
     ON CONFLICT (kind, model) DO UPDATE SET
       thinking_efforts = EXCLUDED.thinking_efforts,
       updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(payload)],
  );
  return normalized.length;
}

/** Read all persisted agent models and supported thinking efforts from Postgres. */
export async function readAgentModels(
  kindFilter?: AgentKind,
): Promise<AgentModelsByKind> {
  const out: AgentModelsByKind = {
    pi: [],
    claude: [],
    cursor: [],
    devin: [],
    codex: [],
  };
  const params: unknown[] = [];
  const where =
    kindFilter && AGENT_KINDS.includes(kindFilter)
      ? (params.push(kindFilter), `WHERE kind = $1`)
      : "";
  const { rows } = await getPool().query<{
    kind: AgentKind;
    model: string;
    thinking_efforts: unknown;
  }>(
    `SELECT kind, model, thinking_efforts
     FROM agent_models
     ${where}
     ORDER BY kind ASC, model ASC`,
    params,
  );
  for (const row of rows) {
    if (!AGENT_KINDS.includes(row.kind)) continue;
    const efforts = Array.isArray(row.thinking_efforts)
      ? normalizeEfforts(row.thinking_efforts)
      : [];
    out[row.kind].push({
      model: row.model,
      thinkingEfforts: efforts,
    });
  }
  return out;
}

/**
 * Fetch models and supported thinking efforts for every supported agent on startup.
 * Upserts into `agent_models` when an agent succeeds; leaves existing DB rows
 * untouched when fetching for that agent fails or returns empty.
 */
export async function syncAgentModelsOnStartup(
  fetcher: AgentModelFetcher = fetchAgentModelsFromCli,
): Promise<{ updated: AgentKind[]; failed: AgentKind[] }> {
  const updated: AgentKind[] = [];
  const failed: AgentKind[] = [];

  const syncOne = async (kind: AgentKind): Promise<void> => {
    try {
      const models = await fetcher(kind);
      const normalized = normalizeAgentModelRecords(models);
      if (!normalized.length) {
        failed.push(kind);
        console.warn(`[models] ${kind}: empty model list, skipping DB update`);
        return;
      }
      const count = await upsertAgentModelsForKind(kind, normalized);
      if (count > 0) {
        updated.push(kind);
        console.log(`[models] ${kind}: synced ${count} model(s) to database`);
      } else {
        failed.push(kind);
      }
    } catch (err) {
      failed.push(kind);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[models] ${kind}: failed to fetch models (${msg}), skipping DB update`);
    }
  };

  await Promise.allSettled(AGENT_KINDS.map((kind) => syncOne(kind)));

  return { updated, failed };
}
