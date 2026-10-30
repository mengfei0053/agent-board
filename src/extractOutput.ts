/** Extract human-readable assistant output from agent CLI JSONL event lines. */

import type { OutputTurn, PromptTurn } from "./types.js";

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    const block = p as Record<string, unknown>;
    const typ = block.type;
    if (typ === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (typ === "output_text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (typeof block.text === "string" && !typ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n").trim();
}

/** Recover pi text_end payload from a truncated / broken JSON line. */
function textEndFromTruncatedLine(line: string): string | undefined {
  if (!line.includes("text_end")) return undefined;
  const m = line.match(
    /"type"\s*:\s*"text_end"[\s\S]*?"content"\s*:\s*"((?:\\.|[^"\\])*)"/,
  );
  if (!m) return undefined;
  try {
    const text = JSON.parse(`"${m[1]}"`);
    if (typeof text === "string" && text.trim()) return text.trim();
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Pull assistant-visible text from a single JSONL event, if any. */
export function extractTextFromEventLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    // Truncated agent dumps may still carry a usable pi text_end payload.
    return textEndFromTruncatedLine(trimmed);
  }
  const t = ev.type;

  // Stored when a JSON line was cut before persist. Not assistant prose by itself.
  if (t === "log_truncated" && typeof ev.recoveredText === "string" && ev.recoveredText.trim()) {
    return ev.recoveredText.trim();
  }

  // pi: final streamed assistant text (preferred over thinking-only message_end)
  if (t === "message_update" && ev.assistantMessageEvent) {
    const ame = ev.assistantMessageEvent as Record<string, unknown>;
    if (ame.type === "text_end" && typeof ame.content === "string" && ame.content.trim()) {
      return ame.content.trim();
    }
  }

  // pi: complete assistant message
  if (t === "message_end" && ev.message?.role === "assistant") {
    const text = textFromContent(ev.message.content);
    if (text) return text;
  }

  // Claude Code stream-json: assistant message
  if (t === "assistant" && ev.message) {
    const text = textFromContent(ev.message.content);
    if (text) return text;
  }


  // Codex exec --json: item.completed with agent_message / assistant_message
  if (t === "item.completed" || t === "item.updated") {
    const item = ev.item;
    if (item && typeof item === "object") {
      const it = item as Record<string, unknown>;
      const ity = it.type || it.item_type;
      if (
        (ity === "agent_message" || ity === "assistant_message") &&
        typeof it.text === "string" &&
        it.text.trim()
      ) {
        return it.text.trim();
      }
      if (typeof it.message === "string" && it.message.trim()) {
        return it.message.trim();
      }
    }
  }

  // Codex event_msg / task_complete style (rollouts)
  if (t === "event_msg" && ev.payload) {
    const p = ev.payload as Record<string, unknown>;
    if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
      return p.message.trim();
    }
    if (p.type === "task_complete" && typeof p.last_agent_message === "string" && p.last_agent_message.trim()) {
      return p.last_agent_message.trim();
    }
  }

  // Cursor / Claude result event
  if (t === "result") {
    if (typeof ev.result === "string" && ev.result.trim()) return ev.result.trim();
    if (typeof ev.content === "string" && ev.content.trim()) return ev.content.trim();
    const text = textFromContent(ev.content);
    if (text) return text;
  }

  // Generic
  if (ev.message?.role === "assistant") {
    const text = textFromContent(ev.message.content);
    if (text) return text;
  }

  return undefined;
}


export const BOARD_META_TYPE_LIST = [
  "spawn",
  "exit",
  "continue",
  "start",
  "continue_fallback",
  "cursor_create_chat",
  "cursor_create_chat_failed",
  "cursor_create_chat_error",
  "devin_list_failed",
  "devin_list_error",
  "devin_session",
  "devin_session_unbound",
] as const;

const BOARD_META_TYPES = new Set<string>(BOARD_META_TYPE_LIST);

/** POSIX regex for Postgres `~`. Used to retain meta rows across the same trim as memory. */
export function boardMetaLineSqlPattern(): string {
  return `"type"[[:space:]]*:[[:space:]]*"(${BOARD_META_TYPE_LIST.join("|")})"`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

export function isBoardMetaLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("{")) return false;
  try {
    const ev = JSON.parse(t) as { type?: string };
    return typeof ev.type === "string" && BOARD_META_TYPES.has(ev.type);
  } catch {
    return false;
  }
}

/** Collect non-JSON / non-board-meta stdout as plain assistant output (e.g. Devin -p). */
function plainTextFromRange(lines: string[], from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i < to; i++) {
    const raw = lines[i] ?? "";
    const cleaned = stripAnsi(raw).replace(/\r/g, "").trimEnd();
    const t = cleaned.trim();
    if (!t) continue;
    if (isBoardMetaLine(t)) continue;
    if (t.startsWith("{") || t.startsWith("[")) {
      // Valid JSON is handled by extractTextFromEventLine. Broken JSON
      // (truncated persist) must not be merged into the reply body.
      continue;
    }
    parts.push(cleaned);
  }
  return parts.join("\n").trim();
}

function upsertTurn(list: OutputTurn[], turn: OutputTurn): OutputTurn[] {
  const next = [...list];
  const idx = next.findIndex((x) => x.iteration === turn.iteration);
  if (idx >= 0) next[idx] = { ...next[idx], ...turn, text: turn.text };
  else next.push(turn);
  return next.sort((a, b) => a.iteration - b.iteration);
}

/**
 * Split logs by start/continue markers and take the last assistant text per segment.
 */
export function extractOutputsByIteration(
  lines: string[],
  fallbackIteration = 1,
): OutputTurn[] {
  type Seg = { start: number; iteration: number };
  const segs: Seg[] = [];
  let currentIter = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; iteration?: number };
      if (ev.type === "start") {
        currentIter = 1;
        segs.push({ start: i, iteration: 1 });
      } else if (ev.type === "continue") {
        currentIter =
          typeof ev.iteration === "number" && ev.iteration >= 1 ? ev.iteration : currentIter + 1;
        segs.push({ start: i, iteration: currentIter });
      }
    } catch {
      /* ignore */
    }
  }

  if (!segs.length) {
    let last = "";
    for (const line of lines) {
      const text = extractTextFromEventLine(line ?? "");
      if (text) last = text;
    }
    if (!last) last = plainTextFromRange(lines, 0, lines.length);
    const iter =
      typeof fallbackIteration === "number" && fallbackIteration >= 1 ? fallbackIteration : 1;
    return last ? [{ iteration: iter, text: last }] : [];
  }

  let turns: OutputTurn[] = [];
  for (let s = 0; s < segs.length; s++) {
    const from = segs[s].start;
    const to = s + 1 < segs.length ? segs[s + 1].start : lines.length;
    let last = "";
    for (let i = from; i < to; i++) {
      const text = extractTextFromEventLine(lines[i] ?? "");
      if (text) last = text;
    }
    if (!last) last = plainTextFromRange(lines, from, to);
    if (last) {
      turns = upsertTurn(turns, { iteration: segs[s].iteration, text: last });
    }
  }
  return turns;
}

export function latestOutputText(turns: OutputTurn[] | undefined): string {
  if (!turns?.length) return "";
  return turns[turns.length - 1]?.text ?? "";
}

export function upsertOutputTurn(
  existing: OutputTurn[] | undefined,
  turn: OutputTurn,
): OutputTurn[] {
  return upsertTurn(existing ?? [], turn);
}

/**
 * Merge log-extracted turns into stored ones.
 * Never drop a prior iteration that extraction missed (common when the in-memory
 * log tail lost start/continue markers). If extraction only found a single
 * unmarked turn tagged as iteration 1 while the task is already past round 1,
 * attribute that text to `currentIteration` instead of clobbering round 1.
 */
export function mergeOutputTurns(
  stored: OutputTurn[] | undefined,
  extracted: OutputTurn[],
  currentIteration?: number,
): OutputTurn[] {
  const map = new Map<number, OutputTurn>();
  for (const o of stored || []) {
    if (o?.text?.trim()) map.set(o.iteration, { ...o });
  }

  let adjusted = extracted;
  const cur =
    typeof currentIteration === "number" && currentIteration >= 1 ? currentIteration : undefined;
  if (
    extracted.length === 1 &&
    extracted[0]?.iteration === 1 &&
    cur != null &&
    cur > 1 &&
    extracted[0].text?.trim()
  ) {
    const only = extracted[0];
    const stored1 = map.get(1);
    // Remap when this text is new to iter 1 (or iter 1 already has different text).
    if (!stored1 || stored1.text !== only.text) {
      adjusted = [{ ...only, iteration: cur }];
    }
  }

  for (const o of adjusted) {
    if (!o?.text?.trim()) continue;
    const prev = map.get(o.iteration);
    map.set(o.iteration, {
      ...prev,
      ...o,
      at: o.at || prev?.at,
    });
  }
  return [...map.values()].sort((a, b) => a.iteration - b.iteration);
}

/**
 * Scan log lines (oldest→newest). Returns the last non-empty assistant text
 * in the most recent run segment (after the last spawn/continue/start).
 */
export function extractFinalOutput(lines: string[]): string {
  return latestOutputText(extractOutputsByIteration(lines));
}

export function summarizeOutput(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 1) + "…";
}

export function formatErrorMessage(task: {
  error?: string;
  exitCode?: number | null;
  status?: string;
}): string {
  const bits: string[] = [];
  if (task.error) bits.push(task.error);
  if (task.exitCode != null && task.exitCode !== 0) {
    bits.push(`退出码 ${task.exitCode}`);
  }
  if (!bits.length && task.status === "failed") bits.push("任务失败（无详细错误信息）");
  if (!bits.length && task.status === "stopped") bits.push("已由用户停止");
  return bits.join(" · ");
}

function upsertPrompt(list: PromptTurn[], turn: PromptTurn): PromptTurn[] {
  const next = [...list];
  const idx = next.findIndex((x) => x.iteration === turn.iteration);
  if (idx >= 0) next[idx] = { ...next[idx], ...turn, prompt: turn.prompt };
  else next.push(turn);
  return next.sort((a, b) => a.iteration - b.iteration);
}

export function upsertPromptTurn(
  existing: PromptTurn[] | undefined,
  turn: PromptTurn,
): PromptTurn[] {
  return upsertPrompt(existing ?? [], turn);
}

/**
 * Collect per-iteration user prompts from board meta log lines.
 * Iteration 1 comes from `initialPrompt` (task.prompt); continue events carry later prompts.
 */
export function extractPromptsByIteration(
  lines: string[],
  initialPrompt?: string,
): PromptTurn[] {
  let turns: PromptTurn[] = [];
  const seed = initialPrompt?.trim();
  if (seed) {
    turns = upsertPrompt(turns, { iteration: 1, prompt: seed });
  }

  let currentIter = 1;
  for (const raw of lines) {
    const line = raw?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        iteration?: number;
        prompt?: string;
      };
      if (ev.type === "start") {
        currentIter = 1;
      } else if (ev.type === "continue") {
        currentIter =
          typeof ev.iteration === "number" && ev.iteration >= 1
            ? ev.iteration
            : currentIter + 1;
        const prompt = typeof ev.prompt === "string" ? ev.prompt.trim() : "";
        if (prompt) {
          turns = upsertPrompt(turns, { iteration: currentIter, prompt });
        }
      }
    } catch {
      /* ignore */
    }
  }
  return turns;
}

export function mergePromptTurns(
  stored: PromptTurn[] | undefined,
  extracted: PromptTurn[],
): PromptTurn[] {
  const map = new Map<number, PromptTurn>();
  for (const p of extracted) {
    if (p?.prompt?.trim()) map.set(p.iteration, p);
  }
  // Stored / explicit turns win over log extraction.
  for (const p of stored || []) {
    if (p?.prompt?.trim()) map.set(p.iteration, p);
  }
  return [...map.values()].sort((a, b) => a.iteration - b.iteration);
}

