/** Extract human-readable assistant output from agent CLI JSONL event lines. */

import type { OutputTurn } from "./types.js";

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

/** Pull assistant-visible text from a single JSONL event, if any. */
export function extractTextFromEventLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const t = ev.type;

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


const BOARD_META_TYPES = new Set([
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
]);

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function isBoardMetaLine(line: string): boolean {
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
    if (t.startsWith("{")) {
      // JSON event lines are handled by extractTextFromEventLine; skip for plain fallback
      try {
        JSON.parse(t);
        continue;
      } catch {
        /* keep as plain */
      }
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
export function extractOutputsByIteration(lines: string[]): OutputTurn[] {
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
    return last ? [{ iteration: 1, text: last }] : [];
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
