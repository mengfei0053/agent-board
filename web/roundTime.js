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
  const diffMs = endMs - startMs;
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
