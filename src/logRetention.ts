import { extractTextFromEventLine, isBoardMetaLine } from "./extractOutput.js";

/** Cap a single stored/displayed log line. */
export const MAX_LOG_LINE_CHARS = 8_000;
/** Soft cap for lines kept per task (memory and Postgres). */
export const MAX_LOG_LINES_KEPT = 3_000;
/** Char budget applied after the line-count selection. Shared by memory and DB. */
export const MAX_LOG_CHARS_KEPT = 1_500_000;
/** UI/API default: last N lines. */
export const DEFAULT_LOG_TAIL_LINES = 400;
/** UI/API default: total chars across returned lines. */
export const DEFAULT_LOG_TAIL_CHARS = 240_000;

export function truncateLogLine(line: string, maxChars = MAX_LOG_LINE_CHARS): string {
  if (line.length <= maxChars) return line;
  const omitted = line.length - maxChars;
  return `${line.slice(0, maxChars)}…[truncated ${omitted} chars]`;
}

/**
 * Persist a bounded line. JSON-looking lines are wrapped so a mid-string cut
 * is not later treated as assistant prose. Display truncation stays separate.
 */
export function boundStoredLogLine(line: string, maxChars = MAX_LOG_LINE_CHARS): string {
  const raw = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (raw.length <= maxChars) return raw;
  const head = raw.slice(0, maxChars);
  const trimmed = head.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // Parse the full event so a long final result stays recoverable. A cut
    // prefix is not valid JSON and would lose the text to an older short result.
    const recovered = extractTextFromEventLine(raw) || extractTextFromEventLine(head);
    return JSON.stringify({
      type: "log_truncated",
      originalChars: raw.length,
      ...(recovered ? { recoveredText: recovered } : { preview: head.slice(0, 240) }),
    });
  }
  return truncateLogLine(raw, maxChars);
}

function applyCharBudget(lines: string[], indices: number[], maxChars: number): number[] {
  if (maxChars <= 0) return [];
  let total = 0;
  for (const i of indices) total += (lines[i] ?? "").length;
  if (total <= maxChars) return indices;
  const meta = new Set(indices.filter((i) => isBoardMetaLine(lines[i] ?? "")));
  const next = [...indices];
  const dropOldest = (onlyOrdinary: boolean) => {
    const idx = onlyOrdinary ? next.findIndex((i) => !meta.has(i)) : 0;
    if (idx < 0) return false;
    total -= (lines[next[idx]] ?? "").length;
    next.splice(idx, 1);
    return true;
  };
  while (total > maxChars && next.some((i) => !meta.has(i))) {
    if (!dropOldest(true)) break;
  }
  while (total > maxChars && next.length) {
    if (!dropOldest(false)) break;
  }
  return next;
}

/**
 * Indices to retain, in original order.
 * Meta lines are preferred, then the newest ordinary lines, capped by
 * `maxLines`. A zero ordinary budget keeps zero ordinary lines (`slice(-0)`
 * must not mean "keep all"). Meta itself is also capped.
 */
export function keptLogIndices(
  lines: string[],
  maxLines = MAX_LOG_LINES_KEPT,
  maxChars = MAX_LOG_CHARS_KEPT,
): number[] {
  const cap = Math.max(0, Math.trunc(maxLines));
  if (cap === 0 || maxChars <= 0) return [];
  const all = lines.map((_, i) => i);
  if (lines.length <= cap) return applyCharBudget(lines, all, maxChars);

  const meta: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBoardMetaLine(lines[i] ?? "")) meta.push(i);
    else rest.push(i);
  }
  const metaKeep = meta.length > cap ? meta.slice(meta.length - cap) : meta;
  const keepRest = cap - metaKeep.length;
  const restKeep = keepRest <= 0 ? [] : rest.slice(-keepRest);
  const selected = [...metaKeep, ...restKeep].sort((a, b) => a - b);
  return applyCharBudget(lines, selected, maxChars);
}

/** In-place trim. Selected lines stay in their original relative order. */
export function trimLogsKeepingMeta(arr: string[], maxLines = MAX_LOG_LINES_KEPT): void {
  const idx = keptLogIndices(arr, maxLines);
  if (idx.length === arr.length) return;
  const next = idx.map((i) => arr[i]!);
  arr.length = 0;
  arr.push(...next);
}
