import { databaseKind, getPool } from "./db.js";
import type { DatabaseClient } from "./databaseAdapter.js";
import { usageRange } from "./usageRange.js";
import { flushUsage } from "./usageStats.js";

type Query = Record<string, string>;
type Range = ReturnType<typeof usageRange>;
type Sql = { sql: string; values: (string | number)[] };
const numberOrNull = (v: unknown) => (v == null ? null : Number(v));

/** Compose only the fixed report templates below; all filter values travel separately as bindings. */
function select(client: DatabaseClient, scope: Sql, projection: string) {
  return client.query([scope.sql, projection].join(" "), scope.values);
}

function filters(q: Query, range: Range, dimensions: string[]): Sql {
  const values: (string | number)[] = [range.from, range.to];
  const conditions = ["e.occurred_ms >= $1", "e.occurred_ms < $2"];
  for (const column of dimensions) {
    // column names come only from the lists below
    const value = q[column];
    if (q[`${column}Unknown`] === "1" || (column === "status" && value === "unknown"))
      conditions.push(`e.${column} IS NULL`);
    else if (value !== undefined) conditions.push(`e.${column} = $${values.push(value)}`);
  }
  return { sql: conditions.join(" AND "), values };
}

// Codex includes reads in input and does not report a separately billed write bucket.
// Quotes fill *missing* costs only, never overwrite source data. NULL arithmetic is intentional.
const billedWrite = "CASE WHEN e.agent='codex' THEN 0 ELSE e.cache_write END";
const quote = `(e.fresh_input*p.input_rate + e.output_tokens*p.output_rate + e.cache_read*p.read_rate + (${billedWrite})*p.write_rate)/1000000.0`;
const candidate = "requests=1 AND status='success' AND duration_ms>0";
const elapsed = "(duration_ms-first_token_ms)";
const timed = `${candidate} AND output_tokens>=100 AND first_token_ms>=0 AND ${elapsed}>0 AND 1000.0*output_tokens/NULLIF(${elapsed},0)<=10000`;
const estimated = `${candidate} AND output_tokens>=200 AND first_token_ms IS NULL AND 1000.0*output_tokens/NULLIF(duration_ms,0)<=10000`;

function baseSql(where: string) {
  return `WITH priced AS (
    SELECT e.*, COALESCE(e.cost_usd, ${quote}) AS cost,
      CASE WHEN e.cost_usd IS NOT NULL THEN COALESCE(e.cost_source,'legacy-cli') WHEN ${quote} IS NOT NULL THEN 'local-price' END AS basis,
      e.fresh_input+e.cache_read+(${billedWrite}) AS cache_input
    FROM usage_events e LEFT JOIN usage_prices p ON e.model=p.model WHERE ${where}
  ), sample AS (
    SELECT priced.*, CASE WHEN ${timed} THEN ${elapsed} END AS gen_ms, CASE WHEN ${estimated} THEN duration_ms END AS est_ms,
      CASE WHEN requests=1 AND status='success' THEN first_token_ms END AS ttft
    FROM priced
  )`;
}

const aggregates = {
  records: "COUNT(*)",
  oldest: "MIN(occurred_ms)",
  legacyRecords: "COUNT(*)-COUNT(source)",
  requests: "SUM(requests)",
  requestRecords: "COUNT(requests)",
  tokens: "SUM(total_tokens)",
  tokenRecords: "COUNT(total_tokens)",
  costUsd: "SUM(cost)",
  costRecords: "COUNT(cost)",
  estimatedCosts: "COUNT(CASE WHEN basis<>'provider' THEN 1 END)",
  input: "SUM(fresh_input)",
  inputRecords: "COUNT(fresh_input)",
  output: "SUM(output_tokens)",
  outputRecords: "COUNT(output_tokens)",
  cacheRead: "SUM(cache_read)",
  cacheReadRecords: "COUNT(cache_read)",
  cacheWrite: "SUM(cache_write)",
  cacheWriteRecords: "COUNT(cache_write)",
  cacheRate: "1.0*SUM(CASE WHEN cache_input IS NOT NULL THEN cache_read END)/NULLIF(SUM(cache_input),0)",
  cacheRecords: "COUNT(cache_input)",
};
const performance = {
  statusRecords: "COUNT(CASE WHEN requests=1 THEN status END)",
  successRate:
    "1.0*COUNT(CASE WHEN requests=1 AND status='success' THEN 1 END)/NULLIF(COUNT(CASE WHEN requests=1 THEN status END),0)",
  measuredSpeed: "1000.0*SUM(CASE WHEN gen_ms IS NOT NULL THEN output_tokens END)/NULLIF(SUM(gen_ms),0)",
  estimatedSpeed: "1000.0*SUM(CASE WHEN est_ms IS NOT NULL THEN output_tokens END)/NULLIF(SUM(est_ms),0)",
  measuredSamples: "COUNT(gen_ms)",
  estimatedSamples: "COUNT(est_ms)",
  firstTokenRecords: "COUNT(ttft)",
};
const selectMetrics = (columns: Record<string, string>) =>
  Object.entries(columns)
    .map(([alias, expr]) => `${expr} AS "${alias}"`)
    .join(",");
const rollup = selectMetrics(aggregates);
function numbers(row: Record<string, unknown>, columns: Record<string, string> = aggregates) {
  return Object.fromEntries(Object.keys(columns).map((key) => [key, numberOrNull(row[key])]));
}

async function grouped(client: DatabaseClient, scope: Sql, dim: "agent" | "provider" | "model") {
  // Window ranks over known first tokens only (NULLs last); avg of the middle 1/2 works in both DBs.
  const mid = "AVG(CASE WHEN rn*2 BETWEEN n AND n+2 THEN ttft END)";
  const sql = `${scope.sql}, ranked AS (SELECT sample.*, ROW_NUMBER() OVER (PARTITION BY ${dim} ORDER BY ttft NULLS LAST) AS rn,
    COUNT(ttft) OVER (PARTITION BY ${dim}) AS n FROM sample)
    SELECT ${dim}, ${rollup}, ${selectMetrics(performance)}, ${mid} AS median FROM ranked GROUP BY ${dim}
    ORDER BY SUM(requests) DESC NULLS LAST, ${dim} ASC NULLS LAST`;
  const { rows } = await client.query(sql, scope.values);
  return rows.map((row) => {
    const perf = numbers(row, performance);
    return {
      [dim]: row[dim],
      ...numbers(row),
      ...perf,
      firstTokenMs: numberOrNull(row.median),
      speed: perf.measuredSpeed ?? perf.estimatedSpeed,
      speedEstimated: perf.measuredSpeed === null && perf.estimatedSpeed !== null,
    };
  });
}

async function chart(client: DatabaseClient, scope: Sql, bins: number[][]) {
  const values = [...scope.values];
  const bounds = bins.map(
    ([start, end]) => `(CAST($${values.push(start)} AS BIGINT),CAST($${values.push(end)} AS BIGINT))`,
  );
  const { rows } = await select(
    client,
    { ...scope, values },
    `, bins(lo,hi) AS (VALUES ${bounds.join(",")})
    SELECT lo, ${rollup} FROM bins JOIN sample ON occurred_ms>=lo AND occurred_ms<hi GROUP BY lo ORDER BY lo`,
  );
  return rows.map((row) => ({ start: Number(row.lo), ...numbers(row) }));
}

async function logPage(client: DatabaseClient, scope: Sql, page: number, pageSize: number) {
  const values = [...scope.values];
  const { rows } = await select(
    client,
    { ...scope, values },
    `SELECT occurred_ms AS at, agent, provider, model, source, status, requests,
    fresh_input AS input, output_tokens AS output, cache_read AS "cacheRead", cache_write AS "cacheWrite", total_tokens AS tokens,
    cost AS "costUsd", basis AS "costSource", duration_ms AS "durationMs", first_token_ms AS "firstTokenMs",
    1000.0*output_tokens/COALESCE(gen_ms,est_ms) AS speed, est_ms AS estimated
    FROM sample ORDER BY occurred_ms DESC, run_key DESC, event_key DESC LIMIT $${values.push(pageSize)} OFFSET $${values.push((page - 1) * pageSize)}`,
  );
  return rows.map(({ estimated: est, ...row }) => ({
    ...row,
    ...Object.fromEntries(
      [
        "at",
        "requests",
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "tokens",
        "costUsd",
        "durationMs",
        "firstTokenMs",
        "speed",
      ].map((k) => [k, numberOrNull(row[k])]),
    ),
    speedEstimated: est != null,
  }));
}

async function choices(client: DatabaseClient, q: Query, range: Range, dim: "provider" | "model") {
  const dims = ["agent", "status"];
  if (dim === "model") dims.push("provider");
  const scope = filters(q, range, dims);
  const sql = [
    dim === "provider" ? "SELECT DISTINCT provider" : "SELECT DISTINCT model",
    "FROM usage_events e WHERE",
    scope.sql,
    "ORDER BY 1 NULLS LAST",
  ].join(" ");
  const { rows } = await client.query(sql, scope.values);
  return rows.map((row) => row[dim]);
}

/** One read snapshot: page totals, cards, bins and both independent groupings cannot race a new batch. */
export async function queryUsage(q: Query) {
  const range = usageRange(q);
  const scope = filters(q, range, ["agent", "status", "provider", "model"]);
  scope.sql = baseSql(scope.sql);
  await flushUsage();
  const client = await getPool().connect();
  try {
    await client.query(
      databaseKind() === "sqlite" ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const total = (await select(client, scope, `SELECT ${rollup} FROM sample`)).rows[0];
    const summary = numbers(total);
    const page = Math.min(range.page, Math.max(1, Math.ceil(Number(summary.records) / range.pageSize)));
    const result = {
      summary,
      byAgent: await grouped(client, scope, "agent"),
      providers: await grouped(client, scope, "provider"),
      models: await grouped(client, scope, "model"),
      slots: range.bins.map(([start]) => start),
      trend: await chart(client, scope, range.bins),
      page,
      pageSize: range.pageSize,
      logs: await logPage(client, scope, page, range.pageSize),
      choices: {
        providers: await choices(client, q, range, "provider"),
        models: await choices(client, q, range, "model"),
      },
    };
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
