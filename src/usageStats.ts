import { AGENT_KINDS } from "./agentModels.js";
import { insertRows } from "./databaseAdapter.js";
import { getPool } from "./db.js";
import { HttpError } from "./httpError.js";
import type { AgentKind } from "./types.js";
import type { RunnerUsage } from "./usageRecord.js";

const columns = ["run_key", "event_key", "occurred_ms", "agent", "model", "fresh_input", "output_tokens", "cache_read", "cache_write", "total_tokens", "cost_usd", "requests"];
const pending: unknown[][] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> | undefined;
let warned = false;

function schedule(ms: number) {
  if (timer || writing) return;
  timer = setTimeout(() => { timer = undefined; void flushUsage().catch(() => {}); }, ms);
  timer.unref();
}

/** No DB calls or broadcasts on the runner output path. Don't let a broken DB stall a task. */
export function recordUsage(run: string, agent: AgentKind, u: RunnerUsage, at = Date.now()) {
  if (pending.length >= 5000) {
    if (!warned) console.warn("[usage] buffer full; dropping new usage until database recovers");
    warned = true;
    return;
  }
  pending.push([run, u.key, at, agent, u.model ?? null, u.input, u.output, u.cacheRead, u.cacheWrite, u.total, u.costUsd, u.requests]);
  schedule(250);
}

export async function flushUsage(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (writing) await writing;
  if (!pending.length) return;
  // Other waiters may have started a new batch while we awaited the old one.
  if (writing) return flushUsage();
  const batch = pending.splice(0);
  writing = insertRows(getPool(), "usage_events", columns, batch, "ON CONFLICT (run_key, event_key) DO NOTHING")
    .then(() => { warned = false; })
    .catch((err) => {
      console.error("[usage] batch write failed; retrying:", err);
      pending.unshift(...batch.slice(0, Math.max(0, 5000 - pending.length)));
      throw err;
    }).finally(() => {
      writing = undefined;
      if (pending.length) schedule(1000);
    });
  await writing;
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
function integer(raw: string | undefined, name: string, min: number, max: number) {
  const n = Number(raw);
  if (!raw || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `invalid ${name}`);
  return n;
}

/** Calendar bins, not 24h elapsed intervals: a local day can have 23 or 25 hours. */
function timeBins(from: number, to: number, size: number, offset: number, zone?: string) {
  let label: Intl.DateTimeFormat | undefined;
  if (zone !== undefined) {
    try {
      label = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric",
        ...(size === HOUR ? { hour: "numeric", timeZoneName: "shortOffset" as const } : {}) });
    } catch { throw new HttpError(400, "invalid timezone"); }
  }
  const bins: number[][] = [];
  for (let t = from; t < to;) {
    let end = (Math.floor((t + offset) / size) + 1) * size - offset;
    if (label) {
      const current = label.format(t);
      // Fast path for ordinary whole bins. Binary search only partial bins / offset changes.
      end = t + size;
      if (label.format(end - 1) !== current || label.format(end) === current) {
        let lo = t, hi = Math.min(to, t + 2 * size);
        if (label.format(hi) !== current) {
          while (hi - lo > 1) {
            const mid = lo + Math.floor((hi - lo) / 2);
            if (label.format(mid) === current) lo = mid; else hi = mid;
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

const sums = ["records", "requests", "requestRecords", "tokens", "tokenRecords", "costUsd", "costRecords", "hits", "cacheInput", "cacheRecords"] as const;
type Counts = Record<typeof sums[number], number>;
function empty(): Counts {
  return { records: 0, requests: 0, requestRecords: 0, tokens: 0, tokenRecords: 0, costUsd: 0, costRecords: 0, hits: 0, cacheInput: 0, cacheRecords: 0 };
}
function metrics({ hits, cacheInput, ...row }: Counts) {
  return { ...row, requests: row.requestRecords ? row.requests : null, costUsd: row.costRecords ? row.costUsd : null,
    tokens: row.tokenRecords ? row.tokens : null, cacheRate: cacheInput ? hits / cacheInput : null };
}

export async function queryUsage(query: Record<string, string>) {
  const from = integer(query.from, "from", 0, 4102444800000), to = integer(query.to, "to", 1, 4102444800000);
  const size = query.bucket === "day" ? DAY : query.bucket === "hour" ? HOUR : 0;
  if (!size || to <= from || to - from > (size === DAY ? 366 : 32) * DAY) throw new HttpError(400, "invalid bucket or date range");
  const offset = integer(query.offset ?? "0", "offset", -840, 840) * 60000;
  const agent = query.agent;
  if (agent !== undefined && !AGENT_KINDS.includes(agent as AgentKind)) throw new HttpError(400, "invalid agent");
  const bins = timeBins(from, to, size, offset, query.timezone);
  const values: (number | string)[] = bins.flat();
  const ranges = bins.map((_, i) => `(CAST($${2*i+1} AS BIGINT), CAST($${2*i+2} AS BIGINT))`);
  // Codex reports cache reads within inclusive input; fresh_input already excludes them.
  // It has no separate cache-write bucket. Unknown cache fields for other agents stay unknown.
  const denominator = `fresh_input + cache_read + CASE WHEN agent = 'codex' THEN 0 ELSE cache_write END`;
  await flushUsage();
  const { rows } = await getPool().query<Counts & { start_ms: number; agent: string }>(`
    WITH bins(start_ms, end_ms) AS (VALUES ${ranges.join(",")})
    SELECT start_ms, agent, COUNT(*) AS records, SUM(requests) AS requests, COUNT(requests) AS "requestRecords",
      SUM(total_tokens) AS tokens, COUNT(total_tokens) AS "tokenRecords", SUM(cost_usd) AS "costUsd", COUNT(cost_usd) AS "costRecords",
      SUM(CASE WHEN (${denominator}) IS NOT NULL THEN cache_read END) AS hits,
      SUM(${denominator}) AS "cacheInput", COUNT(${denominator}) AS "cacheRecords"
    FROM bins JOIN usage_events ON occurred_ms >= start_ms AND occurred_ms < end_ms
    ${agent ? `WHERE agent = $${values.push(agent)}` : ""}
    GROUP BY start_ms, agent ORDER BY start_ms, agent`, values);
  const total = empty(), agents = new Map<string, Counts>(), trend = new Map<number, Counts>();
  for (const row of rows) {
    const a = agents.get(row.agent) ?? empty(), t = trend.get(Number(row.start_ms)) ?? empty();
    agents.set(row.agent, a); trend.set(Number(row.start_ms), t);
    for (const key of sums) { const n = Number(row[key]); a[key] += n; t[key] += n; total[key] += n; }
  }
  return { slots: bins.map(([start]) => start), summary: metrics(total), byAgent: Array.from(agents, ([agent, a]) => ({ agent, ...metrics(a) })).sort((a, b) => b.records - a.records),
    trend: Array.from(trend, ([start, t]) => ({ start, ...metrics(t) })) };
}
