import { AGENT_KINDS } from "./agentModels.js";
import { HttpError } from "./httpError.js";
import type { AgentKind } from "./types.js";
import { usageLabel } from "./usageRecord.js";

const HOUR = 3_600_000,
  DAY = 24 * HOUR,
  MAX_DATE = 4102444800000;
function integer(raw: string | undefined, name: string, min: number, max: number) {
  const n = Number(raw);
  if (!raw || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max)
    throw new HttpError(400, `invalid ${name}`);
  return n;
}

/** Bins end on actual local boundaries, including skipped/repeated hours and non-hour UTC offsets. */
function timeBins(from: number, to: number, size: number, offset: number, zone?: string) {
  let label: Intl.DateTimeFormat | undefined;
  if (zone !== undefined) {
    try {
      label = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        ...(size === HOUR ? { hour: "numeric", timeZoneName: "shortOffset" as const } : {}),
      });
    } catch {
      throw new HttpError(400, "invalid timezone");
    }
  }
  const bins: number[][] = [];
  for (let t = from; t < to; ) {
    let end = (Math.floor((t + offset) / size) + 1) * size - offset;
    if (label) {
      const current = label.format(t);
      end = t + size;
      if (label.format(end - 1) !== current || label.format(end) === current) {
        let lo = t,
          hi = Math.min(to, t + 2 * size);
        if (label.format(hi) !== current) {
          while (hi - lo > 1) {
            const mid = lo + Math.floor((hi - lo) / 2);
            if (label.format(mid) === current) lo = mid;
            else hi = mid;
          }
        }
        end = hi;
      }
    }
    bins.push([t, Math.min(end, to)]);
    t = end;
  }
  return bins;
}

export function usageRange(q: Record<string, string>) {
  const from = integer(q.from, "from", 0, MAX_DATE),
    to = integer(q.to, "to", from + 1, MAX_DATE);
  const chartFrom = integer(q.chartFrom ?? q.from, "chartFrom", from, to - 1),
    chartTo = integer(q.chartTo ?? q.to, "chartTo", chartFrom + 1, to);
  const size = new Map([
    ["day", DAY],
    ["hour", HOUR],
  ]).get(q.bucket);
  if (!size || chartTo - chartFrom > (size === DAY ? 372 : 32) * DAY)
    throw new HttpError(400, "invalid bucket or chart range");
  const offset = integer(q.offset ?? "0", "offset", -840, 840) * 60_000;
  if (q.agent !== undefined && !AGENT_KINDS.includes(q.agent as AgentKind))
    throw new HttpError(400, "invalid agent");
  for (const dim of ["provider", "model"]) {
    if (
      (q[dim] !== undefined && usageLabel(q[dim]) !== q[dim]) ||
      (q[`${dim}Unknown`] !== undefined && (q[`${dim}Unknown`] !== "1" || q[dim] !== undefined))
    )
      throw new HttpError(400, `invalid ${dim}`);
  }
  if (q.status !== undefined && !["success", "failed", "aborted", "unknown"].includes(q.status))
    throw new HttpError(400, "invalid status");
  const page = integer(q.page ?? "1", "page", 1, 100_000_000),
    pageSize = integer(q.pageSize ?? "25", "pageSize", 1, 100);
  return { from, to, page, pageSize, bins: timeBins(chartFrom, chartTo, size, offset, q.timezone) };
}
