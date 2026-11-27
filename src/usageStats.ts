import { createHash } from "node:crypto";
import { insertRows } from "./databaseAdapter.js";
import { getPool } from "./db.js";
import type { AgentKind } from "./types.js";
import { usageColumns, usageLabel, type RunnerUsage } from "./usageRecord.js";

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
  const eventKey = createHash("sha256").update(u.key).digest("hex");
  pending.push([run, eventKey, at, agent, usageLabel(u.model) ?? null, u.input, u.output, u.cacheRead, u.cacheWrite, u.total, u.costUsd, u.requests,
    usageLabel(u.provider) ?? null, u.source ?? null, u.status ?? null, u.costSource ?? null, u.durationMs ?? null, u.firstTokenMs ?? null]);
  schedule(250);
}

export async function flushUsage(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (writing) await writing;
  if (writing) return flushUsage();
  if (!pending.length) return;
  const batch = pending.splice(0);
  writing = insertRows(getPool(), "usage_events", usageColumns, batch, "ON CONFLICT (run_key, event_key) DO NOTHING")
    .then(() => { warned = false; })
    .catch((err) => {
      // A driver error can contain SQL parameters/connection details; don't log them.
      console.error("[usage] batch write failed; retrying");
      pending.unshift(...batch.slice(0, Math.max(0, 5000 - pending.length)));
      throw err;
    }).finally(() => {
      writing = undefined;
      if (pending.length) schedule(1000);
    });
  await writing;
}
