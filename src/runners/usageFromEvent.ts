import { createHash } from "node:crypto";
import { usageLabel, type RunnerUsage } from "../usageRecord.js";
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
  if (ev.type !== "result") return;
  const u = fields(ev.usage) ?? {};
  const input = count(u.input_tokens),
    output = count(u.output_tokens);
  const cacheRead = count(u.cache_read_input_tokens),
    cacheWrite = count(u.cache_creation_input_tokens);
  const models = Object.keys(fields(ev.modelUsage) ?? {});
  // The result can cover multiple calls AND models. Never use num_turns as a request count.
  const model = models.length > 1 ? undefined : usageLabel(models[0] ?? ev.model);
  let status: RunnerUsage["status"];
  if (ev.is_error === true) status = "failed";
  else if (ev.subtype === "success") status = "success";
  const costUsd = dollars(ev.total_cost_usd);
  return {
    key: `claude:result:${text(ev.uuid) ?? text(ev.id) ?? "summary"}`,
    source: "claude.result",
    model,
    provider: usageLabel(ev.provider),
    status,
    durationMs: count(ev.duration_ms) ?? undefined,
    costSource: costUsd === null ? undefined : "claude-cli",
    input,
    output,
    cacheRead,
    cacheWrite,
    total: sum(input, output, cacheRead, cacheWrite),
    costUsd,
    requests: null,
  };
}

function codexTurns(now: () => number) {
  let turn = 0,
    started: number | undefined,
    turnKey: string | undefined;
  return (ev: Fields): RunnerUsage | undefined => {
    const id = text(ev.turn_id) ?? text(ev.turnId) ?? text(ev.id);
    if (ev.type === "turn.started") {
      turnKey = id ? `id:${id}` : `seq:${turn + 1}`;
      turn++;
      started = now();
      return;
    }
    if (ev.type !== "turn.completed" && ev.type !== "turn.failed") return;
    const u = fields(ev.usage) ?? {};
    const key = id ? `id:${id}` : (turnKey ?? `seq:${++turn}`);
    const durationMs =
      started !== undefined && (key === turnKey || turnKey?.startsWith("seq:"))
        ? (count(now() - started) ?? undefined)
        : undefined;
    started = undefined;
    const inclusive = count(u.input_tokens),
      output = count(u.output_tokens),
      cached = count(u.cached_input_tokens);
    const cacheRead = cached !== null && inclusive !== null && cached > inclusive ? null : cached;
    return {
      key: `codex:turn:${key}`,
      source: "codex.turn",
      status: ev.type === "turn.failed" ? "failed" : "success",
      durationMs,
      model: usageLabel(ev.model),
      provider: usageLabel(ev.model_provider),
      input: inclusive !== null && cacheRead !== null ? inclusive - cacheRead : null,
      output,
      cacheRead,
      cacheWrite: null,
      total: count(u.total_tokens) ?? sum(inclusive, output),
      costUsd: null,
      requests: null,
    };
  };
}

const piStatus = new Map<string, NonNullable<RunnerUsage["status"]>>([
  ["error", "failed"],
  ["aborted", "aborted"],
  ["stop", "success"],
  ["length", "success"],
  ["toolUse", "success"],
]);
function messageKey(msg: Fields, id: string | undefined, ts: number | null, seq: number) {
  if (id) return `id:${id}`;
  if (ts !== null) return `time:${ts}`;
  if (seq) return `seq:${seq}`;
  return `hash:${createHash("sha256").update(JSON.stringify(msg)).digest("hex")}`;
}

function piMessages(now: () => number) {
  let messageNumber = 0,
    started: number | null = null,
    first: number | null = null;
  return (ev: Fields): RunnerUsage | undefined => {
    const msg = fields(ev.message);
    if (msg?.role !== "assistant") return;
    const ts = count(msg.timestamp); // SDK: wall clock at request start, NOT time of first token.
    if (ev.type === "message_start") {
      messageNumber++;
      started = ts;
      first = null;
      return;
    }
    if (ev.type === "message_update" && first === null && ts !== null && started === ts) {
      const update = fields(ev.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string" && update.delta.length)
        first = count(now() - ts);
      return; // No writes on streaming updates.
    }
    if (ev.type !== "message_end") return;
    const u = fields(msg.usage) ?? {};
    const id = text(msg.responseId) ?? text(msg.id) ?? text(ev.id);
    const key = messageKey(msg, id, ts, messageNumber);
    const input = count(u.input),
      output = count(u.output),
      cacheRead = count(u.cacheRead),
      cacheWrite = count(u.cacheWrite);
    const total = count(u.totalTokens) ?? sum(input, output, cacheRead, cacheWrite);
    const cost = fields(u.cost),
      reported = dollars(cost?.total);
    const costUsd = reported === 0 && cost?.totalFromProvider !== true ? null : reported;
    const status = piStatus.get(String(msg.stopReason));
    const costSource = cost?.totalFromProvider === true ? "provider" : "pi-catalog";
    // Local aborts and synthetic error messages aren't evidence of a provider request.
    const confirmed =
      text(msg.responseId) ||
      status === "success" ||
      [input, output, cacheRead, cacheWrite, total, costUsd].some((n) => n !== null && n > 0);
    const durationMs = count(msg.durationMs) ?? undefined;
    const firstTokenMs =
      ts === started && first !== null && (durationMs === undefined || first <= durationMs)
        ? first
        : undefined;
    started = first = null;
    return {
      key: `pi:message:${key}`,
      source: "pi.message_end",
      model: usageLabel(msg.responseModel) ?? usageLabel(msg.model),
      provider: usageLabel(msg.provider),
      status,
      durationMs,
      firstTokenMs,
      costSource: costUsd === null ? undefined : costSource,
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
      costUsd,
      requests: confirmed ? 1 : null,
    };
  };
}

/** One parser per invocation; output excludes content, diagnostics, endpoint and auth fields. */
export function createUsageParser(kind: "claude" | "codex" | "pi", now = Date.now) {
  const parse = { claude: claudeResult, codex: codexTurns(now), pi: piMessages(now) }[kind];
  const seen = new Set<string>();
  return (event: unknown): RunnerUsage | undefined => {
    const ev = fields(event);
    if (!ev) return;
    const row = parse(ev);
    if (!row || seen.has(row.key)) return;
    if (
      !row.status &&
      !row.requests &&
      [row.input, row.output, row.cacheRead, row.cacheWrite, row.total, row.costUsd].every((n) => n === null)
    )
      return;
    seen.add(row.key);
    return row;
  };
}
