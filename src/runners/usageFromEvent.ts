import { createHash } from "node:crypto";
import type { RunnerUsage } from "../usageRecord.js";
import { fields } from "./eventFields.js";

type Fields = Record<string, unknown>;
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function dollars(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function sum(...parts: (number | null)[]): number | null {
  let total = 0;
  for (const n of parts) {
    if (n === null) return null;
    total += n;
  }
  return count(total);
}

function claudeResult(ev: Fields): RunnerUsage | undefined {
  const u = fields(ev.usage);
  if (ev.type !== "result" || !u) return;
  const input = count(u.input_tokens), output = count(u.output_tokens);
  const cacheRead = count(u.cache_read_input_tokens), cacheWrite = count(u.cache_creation_input_tokens);
  const models = Object.keys(fields(ev.modelUsage) ?? {});
  const model = models.length === 1 ? text(models[0]) : models.length === 0 ? text(ev.model) : undefined;
  // A result aggregates all requests (and possibly several models) of one invocation.
  return {
    key: `claude:result:${text(ev.uuid) ?? text(ev.id) ?? "summary"}`, input, output, cacheRead, cacheWrite,
    total: sum(input, output, cacheRead, cacheWrite), costUsd: dollars(ev.total_cost_usd),
    requests: null, ...(model ? { model } : {}),
  };
}

function codexTurns() {
  let turn = 0;
  let turnKey: string | undefined;
  return (ev: Fields): RunnerUsage | undefined => {
    const id = text(ev.turn_id) ?? text(ev.turnId) ?? text(ev.id);
    if (ev.type === "turn.started") {
      turn++;
      turnKey = id ? `id:${id}` : `seq:${turn}`;
      return;
    }
    const u = fields(ev.usage);
    if (ev.type !== "turn.completed" || !u) return;
    // Without a start or an id, two completions with identical counts may still be different turns.
    const key = id ? `id:${id}` : turnKey ?? `seq:${++turn}`;
    const inclusiveInput = count(u.input_tokens), output = count(u.output_tokens);
    const cached = count(u.cached_input_tokens);
    const cacheRead = cached !== null && inclusiveInput !== null && cached > inclusiveInput ? null : cached;
    const input = inclusiveInput !== null && cacheRead !== null ? inclusiveInput - cacheRead : null;
    const model = text(ev.model);
    return {
      key: `codex:turn:${key}`, input, output, cacheRead, cacheWrite: null,
      total: count(u.total_tokens) ?? sum(inclusiveInput, output), costUsd: null, requests: null,
      ...(model ? { model } : {}),
    };
  };
}

function piMessages() {
  let messageNumber = 0;
  return (ev: Fields): RunnerUsage | undefined => {
    const msg = fields(ev.message);
    if (msg?.role !== "assistant") return;
    if (ev.type === "message_start") { messageNumber++; return; }
    const u = fields(msg.usage);
    if (ev.type !== "message_end" || !u) return;
    const id = text(msg.responseId) ?? text(msg.id) ?? text(ev.id);
    const ts = count(msg.timestamp);
    const key = id ? `id:${id}` : ts !== null ? `time:${ts}` : messageNumber ? `seq:${messageNumber}`
      : `hash:${createHash("sha256").update(JSON.stringify(msg)).digest("hex")}`;
    const model = text(msg.model);
    const input = count(u.input), output = count(u.output);
    const cacheRead = count(u.cacheRead), cacheWrite = count(u.cacheWrite);
    const total = count(u.totalTokens) ?? sum(input, output, cacheRead, cacheWrite);
    // A positive Pi catalog estimate is useful for the dashboard. A synthetic zero
    // can mean missing pricing, so only use zero when the provider reported it.
    const cost = fields(u.cost);
    const reported = dollars(cost?.total);
    const costUsd = reported === 0 && cost?.totalFromProvider !== true ? null : reported;
    // A local abort/error can produce a synthetic assistant message with all counters zero.
    const confirmed = text(msg.responseId) || [input, output, cacheRead, cacheWrite, total, costUsd].some(n => n !== null && n > 0)
      || ["stop", "length", "toolUse"].includes(String(msg.stopReason));
    return {
      key: `pi:message:${key}`, input, output, cacheRead, cacheWrite, total, costUsd,
      requests: confirmed ? 1 : null, ...(model ? { model } : {}),
    };
  };
}

/** One parser per run; seen keys do not leak across invocations or resumed sessions. */
export function createUsageParser(kind: "claude" | "codex" | "pi") {
  const parse = kind === "claude" ? claudeResult : kind === "codex" ? codexTurns() : piMessages();
  const seen = new Set<string>();
  return (event: unknown): RunnerUsage | undefined => {
    const ev = fields(event);
    if (!ev) return;
    const row = parse(ev);
    if (!row || seen.has(row.key)) return;
    if ([row.input, row.output, row.cacheRead, row.cacheWrite, row.total, row.costUsd].every(n => n === null)) return;
    seen.add(row.key);
    return row;
  };
}
