import { after, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, stopTestDb } from "./harness.js";
import { closePool, ensureSchema, getPool } from "../../src/db.js";
import { recordUsage } from "../../src/usageStats.js";
import type { RunnerUsage } from "../../src/usageRecord.js";

await startTestDb();
const base = Date.UTC(2025, 0, 1),
  day = 86400000;
// Real previous-release DDL. Identical setup on SQLite and PostgreSQL, including a retained row.
await getPool()
  .query(`CREATE TABLE usage_events (run_key TEXT NOT NULL, event_key TEXT NOT NULL, occurred_ms BIGINT NOT NULL,
  agent TEXT NOT NULL, model TEXT, fresh_input BIGINT, output_tokens BIGINT, cache_read BIGINT, cache_write BIGINT,
  total_tokens BIGINT, cost_usd DOUBLE PRECISION, requests BIGINT, PRIMARY KEY(run_key,event_key))`);
await getPool().query("INSERT INTO usage_events VALUES ('old','k',$1,'pi',NULL,4,1,0,0,5,0.25,1)", [
  base + 3,
]);
await ensureSchema();
await ensureSchema();
const { app } = await import("../../src/server.js");
after(async () => {
  await closePool();
  await stopTestDb();
});
const common: RunnerUsage = {
  key: "resp",
  source: "pi.message_end",
  status: "success",
  model: "shared",
  provider: "P",
  requests: 1,
  input: 10,
  output: 200,
  cacheRead: 5,
  cacheWrite: 0,
  total: 215,
  costUsd: 1,
  costSource: "provider",
  durationMs: 1100,
  firstTokenMs: 100,
};
const save = (run: string, delta: Partial<RunnerUsage>, at: number) =>
  recordUsage(run, "pi", { ...common, ...delta }, at);
save("a", {}, base + 1);
save("a", {}, base + 5); // same run/event replay, don't move the timestamp
save("b", { durationMs: 2300, firstTokenMs: 300, output: 400, total: 415, costUsd: 0 }, base + 2);
save("c", { provider: "Q", status: "failed", firstTokenMs: undefined, durationMs: 1 }, base + 2);
save("d", { model: "solo", firstTokenMs: undefined, durationMs: 1000, output: 300, total: 315 }, base + 4);
save("e", { model: "fast", durationMs: 100, firstTokenMs: 99 }, base + 5); // >10k/s excluded
recordUsage(
  "turn",
  "codex",
  {
    ...common,
    source: "codex.turn",
    provider: undefined,
    model: "solo",
    requests: null,
    status: "success",
    costSource: undefined,
    costUsd: null,
    firstTokenMs: undefined,
    cacheWrite: null,
  },
  base + 6,
);
function query(extra = "") {
  return `/api/usage?from=${base}&to=${base + day}&bucket=hour&${extra}`;
}
async function read(url: string) {
  const res = await app.request(url);
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}
const price = (method: string, body: unknown) =>
  app.request("/api/usage/prices", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("preserves legacy values/nulls on repeated upgrades; consistent counts, weighted speed, median and status denominators", async () => {
  const r = await read(query());
  assert.equal(r.summary.records, 7);
  assert.equal(r.summary.requests, 6);
  assert.equal(r.summary.legacyRecords, 1);
  assert.equal(r.summary.costRecords, 6);
  assert.equal(r.summary.costUsd, 4.25);
  assert.equal(r.trend[0].tokens, r.summary.tokens);
  assert.deepEqual(
    r.providers.map((p: any) => p.provider),
    ["P", "Q", null],
  );
  assert.deepEqual(
    r.models.map((p: any) => p.model),
    ["shared", "fast", "solo", null],
  );
  for (const groups of [r.providers, r.models, r.byAgent])
    for (const key of ["records", "requests", "costUsd", "tokens", "tokenRecords", "requestRecords"])
      assert.equal(
        groups.reduce((n: number, p: any) => n + (p[key] ?? 0), 0),
        r.summary[key],
      );
  const shared = r.models[0];
  assert.equal(shared.statusRecords, 3);
  assert.equal(shared.successRate, 2 / 3);
  assert.equal(shared.speed, 200);
  assert.equal(shared.measuredSamples, 2);
  assert.equal(shared.firstTokenMs, 200);
  const solo = r.models.find((p: any) => p.model === "solo");
  assert.equal(solo.estimatedSpeed, 300);
  assert.equal(solo.speedEstimated, true);
  assert.equal(solo.firstTokenMs, null);
  assert.equal(solo.statusRecords, 1);
  assert.equal(r.models.find((p: any) => p.model === "fast").speed, null);
  assert.equal(r.providers[0].speed, 200); // measured samples take priority over the duration-only solo model
  assert.equal(r.providers[0].estimatedSamples, 1);
  const old = r.logs.find((p: any) => p.source === null);
  assert.equal(old.costSource, "legacy-cli");
  assert.equal(old.status, null);
  assert.equal(old.provider, null);
  assert.equal(old.durationMs, null);
});

it("paginates with stable descending tie-breakers; scopes filters, choices and unknown groups", async () => {
  const pages = [];
  for (let n = 1; n <= 4; n++) pages.push(await read(query(`page=${n}&pageSize=2`)));
  const logs = pages.flatMap((r) => r.logs);
  assert.equal(logs.length, 7);
  assert.deepEqual(
    logs.map((r) => r.at - base),
    [6, 5, 4, 3, 2, 2, 1],
  );
  assert.equal(logs[4].provider, "Q");
  assert.equal(logs[5].provider, "P");
  assert.deepEqual((await read(query("page=999&pageSize=2"))).logs, pages[3].logs);
  const one = await read(query("provider=Q&model=shared&agent=pi&status=failed"));
  assert.equal(one.summary.records, 1);
  assert.equal(one.providers[0].successRate, 0);
  assert.equal(one.trend[0].records, 1);
  assert.deepEqual(one.choices.models, ["shared"]);
  const unknown = await read(query("providerUnknown=1"));
  assert.equal(unknown.summary.records, 2);
  assert.equal(unknown.providers[0].provider, null);
  assert.equal((await read(query("providerUnknown=1&modelUnknown=1&status=unknown"))).summary.records, 1);
  for (const q of [
    "page=0",
    "pageSize=101",
    "providerUnknown=1&provider=P",
    "modelUnknown=0",
    "status=500",
    "provider=bad%20value",
    "chartTo=9",
  ])
    assert.equal((await app.request(query(q))).status, 400, q);
});

it("local exact-model pricing fills only missing known buckets and is reversible, including explicit zero", async () => {
  const rule = { model: "solo", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  assert.equal((await price("PUT", rule)).status, 200);
  let r = await read(query("model=solo"));
  assert.equal(r.logs[0].costSource, "local-price");
  assert.equal(r.logs[0].costUsd, 425 / 1e6);
  assert.equal(r.logs[1].costUsd, 1);
  assert.equal(r.summary.costUsd, 1 + 425 / 1e6);
  assert.equal((await price("PUT", { ...rule, output: -1 })).status, 400);
  assert.equal((await price("PUT", { ...rule, model: "https://invalid" })).status, 400);
  await price("PUT", { model: "solo", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  r = await read(query("agent=codex"));
  assert.equal(r.summary.costUsd, 0);
  assert.equal(r.summary.costRecords, 1);
  recordUsage("no-input", "pi", { ...common, model: "solo", input: null, costUsd: null }, base + day + 1);
  assert.equal(
    (await read(`/api/usage?from=${base + day}&to=${base + 2 * day}&bucket=day`)).summary.costUsd,
    null,
  );
  await price("DELETE", { model: "solo" });
  assert.deepEqual((await read("/api/usage/prices")).prices, []);
  assert.equal((await read(query("agent=codex"))).summary.costUsd, null);
});

it("all-history totals are not limited to heatmap viewport; half-open bins handle repeated and fractional-offset hours", async () => {
  const r = await read(
    `/api/usage?from=0&to=${base + day}&bucket=day&chartFrom=${base - day}&chartTo=${base}`,
  );
  assert.equal(r.summary.records, 7);
  assert.deepEqual(r.trend, []);
  const lo = Date.parse("2025-11-02T04:30:00Z"),
    hour = 3600000;
  for (let i = 1; i <= 3; i++) save(`dst${i}`, {}, lo + i * hour);
  const dst = await read(`/api/usage?from=${lo}&to=${lo + 4 * hour}&bucket=hour&timezone=America%2FNew_York`);
  assert.deepEqual(
    dst.slots.map((s: number) => (s - lo) / hour),
    [0, 0.5, 1.5, 2.5, 3.5],
  );
  assert.deepEqual(
    dst.trend.map((v: any) => v.start),
    dst.slots.slice(1, 4),
  );
  const nepal = await read(`/api/usage?from=${base}&to=${base + hour}&bucket=hour&timezone=Asia%2FKathmandu`);
  assert.deepEqual(nepal.slots, [base, base + 15 * 60000]);
});
