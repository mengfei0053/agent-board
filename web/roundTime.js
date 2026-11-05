/**
 * Format a round's elapsed duration between two ISO timestamps.
 * Minimum unit: 秒; maximum unit: 小时 (no days).
 * - < 1 minute: X秒
 * - >= 1 minute and < 1 hour: X分钟[Y秒]
 * - >= 1 hour: X小时[Y分钟][Z秒]
 *
 * @param {string | undefined | null} startIso
 * @param {string | undefined | null} endIso
 * @returns {string}
 */
export function formatRoundDuration(startIso, endIso) {
  if (!startIso || !endIso) return "";
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return "";
  return formatDuration(endMs - startMs);
}

function formatDuration(diffMs) {
  const totalSec = diffMs > 0 ? Math.max(1, Math.round(diffMs / 1000)) : 0;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    const parts = [`${hours}小时`];
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (seconds > 0) parts.push(`${seconds}秒`);
    return parts.join("");
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}分钟${seconds}秒` : `${minutes}分钟`;
  }
  return `${seconds}秒`;
}

/**
 * Sum recorded rounds, excluding the idle gaps between them. Older rounds use
 * their last reply time; the current round can use its terminal time or now.
 * @param {{status: string, iteration?: number, startedAt?: string, endedAt?: string,
 *   updatedAt?: string, prompts?: {iteration: number, at?: string}[],
 *   outputs?: {iteration: number, at?: string}[]}} task
 * @param {number} nowMs
 */
export function formatTaskDuration(task, nowMs = Date.now()) {
  if (task.status === "draft") return "";
  const current = task.iteration || 1;
  const active = ["queued", "running", "blocked"].includes(task.status);
  const starts = new Map((task.prompts || []).map((p) => [p.iteration, p.at]));
  const ends = new Map((task.outputs || []).map((o) => [o.iteration, o.at]));
  if (!starts.get(1) && task.startedAt) starts.set(1, task.startedAt);
  let totalMs = 0;
  let hasDuration = false;
  for (const [iteration, startIso] of starts) {
    if (!startIso || iteration > current) continue;
    const startMs = Date.parse(startIso);
    const endIso = ends.get(iteration) || (iteration === current ? task.endedAt || task.updatedAt : "");
    const endMs = active && iteration === current ? nowMs : Date.parse(endIso || "");
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) continue;
    totalMs += endMs - startMs;
    hasDuration = true;
  }
  return hasDuration ? formatDuration(totalMs) : "";
}
