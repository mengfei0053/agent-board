import { after, it } from "node:test";
import assert from "node:assert/strict";
import { startTestDb, stopTestDb } from "./harness.js";
import { closePool, ensureSchema } from "../../src/db.js";
import { recordUsage } from "../../src/usageStats.js";
import type { RunnerUsage } from "../../src/usageRecord.js";

await startTestDb();
await ensureSchema();
const { app } = await import("../../src/server.js");
after(async () => { await closePool(); await stopTestDb(); });
const day = 86400000;
const row: RunnerUsage = { key: "first", input: 2, output: 4, cacheRead: 8, cacheWrite: 0, total: 14, costUsd: 0.25, requests: 1 };
function url(from: number, to: number, extra = "") { return `/api/usage?from=${from}&to=${to}&bucket=day${extra}`; }
async function read(url: string) {
  const resp = await app.request(url);
  const body = await resp.json();
  assert.equal(resp.status, 200, JSON.stringify(body));
  return body;
}

it("deduplicates by run and event, weights cache rate, reports coverage, filters [from,to) and survives reopening", async () => {
  recordUsage("a", "pi", row, day);
  recordUsage("a", "pi", row, day + 1);
  recordUsage("b", "codex", { ...row, input: 18, cacheRead: 2, cacheWrite: null, total: 24, requests: null, costUsd: null }, 2 * day);
  recordUsage("c", "pi", row, 3 * day);
  const r = await read(url(day, 3 * day));
  assert.deepEqual(r.summary, { records: 2, requests: 1, requestRecords: 1, tokens: 38, tokenRecords: 2, costUsd: 0.25, costRecords: 1, cacheRate: 10/30, cacheRecords: 2 });
  assert.deepEqual(r.trend.map((r: {start: number}) => r.start), [day, 2 * day]);
  assert.equal(r.byAgent.length, 2);
  await closePool();
  const onlyCodex = await read(url(day, 3 * day, "&agent=codex"));
  assert.equal(onlyCodex.summary.requests, null);
  assert.equal(onlyCodex.summary.costUsd, null);
  assert.equal(onlyCodex.summary.tokens, 24);
  const empty = await read(url(4*day, 5*day));
  assert.deepEqual(empty.byAgent, []);
  assert.equal(empty.summary.tokens, null);
});

it("groups by local midnight across a daylight-saving transition", async () => {
  const start = Date.parse("2026-03-08T05:00:00Z"), next = start + 23 * 3600000;
  recordUsage("dst1", "pi", row, next - 1);
  recordUsage("dst2", "pi", row, next);
  const r = await read(url(start, next + day, "&timezone=America%2FNew_York&offset=-300"));
  assert.deepEqual(r.trend.map((r: {start: number}) => r.start), [start, next]);
});

it("collects Start and Continue separately, excludes stale callbacks and retains usage after task deletion", async (t) => {
  const { initStore, flushPersist, getDefaultWorkspaceId } = await import("../../src/store.js");
  const { createDraft, startTask, continueTask, removeTasks } = await import("../../src/manager.js");
  const { runners } = await import("../../src/runners/index.js");
  await initStore();
  const original = runners.pi;
  t.after(async () => { runners.pi = original; await flushPersist(); });
  let stale: (() => void) | undefined;
  runners.pi = { start(_task, hooks) {
    hooks.onUsage?.(row);
    hooks.onStatus({ status: "succeeded", sessionId: "test-session" });
    stale = () => hooks.onUsage?.({ ...row, key: "late" });
    return { stop() {} };
  } };
  const task = await createDraft({ kind: "pi", workspaceId: getDefaultWorkspaceId(), prompt: "test" });
  const from = Date.now();
  await startTask(task.id);
  stale?.();
  await continueTask(task.id, "continue");
  await removeTasks([task.id]);
  const r = await read(url(from, Date.now() + 100));
  assert.equal(r.summary.records, 2);
  assert.equal(r.summary.tokens, 28);
  assert.equal(r.summary.requests, 2);
});

it("rejects invalid or excessive ranges, offsets, zones and unknown agents", async () => {
  for (const q of ["", "from=0&to=3600000&bucket=bogus", "from=0&to=4000000000&bucket=hour", "from=0&to=5&bucket=hour&offset=900", "from=0&to=1&bucket=day&timezone=unknown", "from=0&to=1&bucket=day&agent=unknown"]) {
    assert.equal((await app.request(`/api/usage?${q}`)).status, 400, q);
  }
});
