/** Extract human-readable assistant output from agent CLI JSONL event lines. */

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

/**
 * Scan log lines (oldest→newest). Returns the last non-empty assistant text
 * in the most recent run segment (after the last spawn/continue/start).
 */
export function extractFinalOutput(lines: string[]): string {
  let segmentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string };
      if (ev.type === "spawn" || ev.type === "continue" || ev.type === "start") {
        segmentStart = i;
      }
    } catch {
      /* ignore */
    }
  }

  let last = "";
  for (let i = segmentStart; i < lines.length; i++) {
    const text = extractTextFromEventLine(lines[i] ?? "");
    if (text) last = text;
  }
  return last;
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
