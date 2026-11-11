/**
 * Per-agent default model and thinkingEffort settings (meta.agent_defaults).
 */
import { AGENT_KINDS } from "./agentModels.js";
import { getPool } from "./db.js";
import { HttpError } from "./httpError.js";
import { MAX_MODEL_CHARS } from "./limits.js";
import type { AgentKind } from "./types.js";

const META_KEY = "agent_defaults";
const MAX_EFFORT_CHARS = 32;

export type AgentDefaultConfig = {
  model: string;
  thinkingEffort: string;
};

export type AgentDefaultsByKind = Record<AgentKind, AgentDefaultConfig>;
export type AgentDefaultsOverrides = Partial<Record<AgentKind, Partial<AgentDefaultConfig>>>;

let overrides: AgentDefaultsOverrides = {};

function normalizeKindKey(raw: string): AgentKind | null {
  if (raw === "agent") return "cursor";
  if ((AGENT_KINDS as readonly string[]).includes(raw)) return raw as AgentKind;
  return null;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

function cleanModel(raw: unknown, strict = false, kindLabel = ""): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    if (strict) throw new HttpError(400, `agentDefaults.${kindLabel}.model must be a string`);
    return "";
  }
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, "//$1:***@")
    .trim();
  if (cleaned.length > MAX_MODEL_CHARS) {
    if (strict) throw new HttpError(400, `agentDefaults.${kindLabel}.model exceeds max length`);
    return "";
  }
  return cleaned;
}

function cleanEffort(raw: unknown, strict = false, kindLabel = ""): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    if (strict) throw new HttpError(400, `agentDefaults.${kindLabel}.thinkingEffort must be a string`);
    return "";
  }
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase();
  if (cleaned.length > MAX_EFFORT_CHARS) {
    if (strict) throw new HttpError(400, `agentDefaults.${kindLabel}.thinkingEffort exceeds max length`);
    return "";
  }
  return cleaned;
}

/** Pure parse of meta.agent_defaults JSON (exported for tests). */
export function parseAgentDefaultsJson(raw: string | null | undefined): AgentDefaultsOverrides {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return {};
    const out: AgentDefaultsOverrides = {};
    for (const [rawKind, val] of Object.entries(parsed)) {
      const kind = normalizeKindKey(rawKind);
      if (!kind || !isPlainObject(val)) continue;
      const model = cleanModel(val.model);
      const thinkingEffort = cleanEffort(val.thinkingEffort);
      if (model || thinkingEffort) {
        out[kind] = {
          ...(model ? { model } : {}),
          ...(thinkingEffort ? { thinkingEffort } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function serialize(byKind: AgentDefaultsOverrides): string {
  const out: Record<string, Partial<AgentDefaultConfig>> = {};
  for (const kind of AGENT_KINDS) {
    const cur = byKind[kind];
    if (!cur) continue;
    const model = cur.model?.trim() || "";
    const thinkingEffort = cur.thinkingEffort?.trim() || "";
    if (!model && !thinkingEffort) continue;
    out[kind] = {
      ...(model ? { model } : {}),
      ...(thinkingEffort ? { thinkingEffort } : {}),
    };
  }
  return JSON.stringify(out);
}

export async function loadAgentDefaults(): Promise<void> {
  const p = getPool();
  const res = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [META_KEY],
  );
  overrides = parseAgentDefaultsJson(res.rows[0]?.value);
}

export function getAgentDefault(kind: AgentKind): AgentDefaultConfig {
  const cur = overrides[kind];
  return {
    model: cur?.model?.trim() || "",
    thinkingEffort: cur?.thinkingEffort?.trim() || "",
  };
}

export function getAgentDefaultsSettings(): { agentDefaults: AgentDefaultsByKind } {
  const agentDefaults = {} as AgentDefaultsByKind;
  for (const kind of AGENT_KINDS) {
    agentDefaults[kind] = getAgentDefault(kind);
  }
  return { agentDefaults };
}

export function planAgentDefaults(input: unknown): {
  next: AgentDefaultsOverrides;
  json: string;
} {
  if (!isPlainObject(input)) {
    throw new HttpError(400, "agentDefaults must be an object");
  }
  const next: AgentDefaultsOverrides = {};
  for (const kind of AGENT_KINDS) {
    if (overrides[kind]) next[kind] = { ...overrides[kind] };
  }
  for (const [rawKind, val] of Object.entries(input)) {
    const kind = normalizeKindKey(rawKind);
    if (!kind) {
      throw new HttpError(400, `unknown agentDefaults kind: ${rawKind}`);
    }
    if (!isPlainObject(val)) {
      throw new HttpError(400, `agentDefaults.${rawKind} must be an object`);
    }
    const prev = next[kind] || {};
    const hasModel = "model" in val;
    const hasEffort = "thinkingEffort" in val;
    const model = hasModel ? cleanModel(val.model, true, rawKind) : (prev.model || "");
    const thinkingEffort = hasEffort
      ? cleanEffort(val.thinkingEffort, true, rawKind)
      : (prev.thinkingEffort || "");
    if (model || thinkingEffort) {
      next[kind] = {
        ...(model ? { model } : {}),
        ...(thinkingEffort ? { thinkingEffort } : {}),
      };
    } else {
      delete next[kind];
    }
  }
  return { next, json: serialize(next) };
}

export function applyAgentDefaultsMemory(next: AgentDefaultsOverrides): void {
  const copy: AgentDefaultsOverrides = {};
  for (const kind of AGENT_KINDS) {
    const cur = next[kind];
    if (!cur) continue;
    const model = cur.model?.trim() || "";
    const thinkingEffort = cur.thinkingEffort?.trim() || "";
    if (model || thinkingEffort) {
      copy[kind] = {
        ...(model ? { model } : {}),
        ...(thinkingEffort ? { thinkingEffort } : {}),
      };
    }
  }
  overrides = copy;
}

/** @internal test helper — does not persist. */
export function _resetAgentDefaultsForTests(next: AgentDefaultsOverrides = {}): void {
  applyAgentDefaultsMemory(next);
}
