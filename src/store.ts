import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import type { OutputTurn, PromptTurn, SideJob, Task, Workspace } from "./types.js";
import { normalizeWorkspaceSettings } from "./workspaceApply.js";
import {
  archiveJsonDb,
  dataDir,
  ensureDataDirs,
  ensureSchema,
  closePool,
  getPool,
  jsonDbExists,
  listJsonlLogFiles,
  logsDir,
  readJsonDbRaw,
  redactDatabaseUrl,
} from "./db.js";
import { loadCliPathOverrides } from "./cliPaths.js";
import { loadProxyEnvOverrides } from "./proxyEnv.js";
import { loadQuickPrompts } from "./quickPrompts.js";
import { loadCodexSandbox } from "./codexSandbox.js";
import { boardMetaLineSqlPattern } from "./extractOutput.js";
import { collectUploadRefs, gcOrphanUploads } from "./uploads.js";
import { finalizeRunningSideJobs } from "./sideJobs.js";
import {
  boundStoredLogLine,
  DEFAULT_LOG_TAIL_CHARS,
  DEFAULT_LOG_TAIL_LINES,
  keptLogIndices,
  MAX_LOG_CHARS_KEPT,
  MAX_LOG_LINE_CHARS,
  MAX_LOG_LINES_KEPT,
  trimLogsKeepingMeta,
  truncateLogLine,
} from "./logRetention.js";

export { dataDir, logsDir };
export {
  boundStoredLogLine,
  DEFAULT_LOG_TAIL_CHARS,
  DEFAULT_LOG_TAIL_LINES,
  keptLogIndices,
  MAX_LOG_CHARS_KEPT,
  MAX_LOG_LINE_CHARS,
  MAX_LOG_LINES_KEPT,
  trimLogsKeepingMeta,
  truncateLogLine,
};

/** In-memory mirror for sync reads; Postgres is the source of truth after init. */
let tasks = new Map<string, Task>();
let workspaces = new Map<string, Workspace>();
let logs = new Map<string, string[]>();


let ready = false;
let persistChain: Promise<void> = Promise.resolve();
let defaultWorkspaceId: string | null = null;
/** Unit tests flip this off so task mutations stay in memory. */
let persistWrites = true;
/** Unit tests: queued persist jobs succeed without Postgres. */
let persistDryRun = false;

type TasksDeletedListener = (ids: string[]) => void;
/** Fired with ids just removed from the in-memory map (before async persist). */
let tasksDeletedListener: TasksDeletedListener | null = null;

/** Manager registers this so deferred per-task work dies with the row. */
export function setTasksDeletedListener(listener: TasksDeletedListener | null): void {
  tasksDeletedListener = listener;
}

function normalizeTask(t: Task): Task {
  return {
    ...t,
    iteration: typeof t.iteration === "number" && t.iteration >= 1 ? t.iteration : 1,
    workspaceId: t.workspaceId || defaultWorkspaceId || "",
  };
}

type PersistOp = "task" | "delete" | "workspace" | "log";

let persistFaults: { op: PersistOp; error: Error }[] = [];
/**
 * Set when a job fails. Cleared only when no unrecovered task snapshots or
 * log rows remain — a later unrelated success must not hide a dropped batch.
 */
let persistDegraded: unknown = null;
/** Failure not yet observed by flushPersist(). */
let unreportedFailure: unknown = null;
let persistDepth = 0;
/** Snapshots that failed mid-batch and must be written again. */
const failedTaskIds = new Set<string>();
/** One automatic retry is chained; further retries wait for flush or a new write. */
let taskRetryQueued = false;
/** True while a log insert failed and those rows are still queued. */
let logPersistFailed = false;
let logRetryQueued = false;
/** Test hook: saveTaskDurable awaits this before writing. */
let durableDelay: Promise<void> | null = null;
let durableWaiters = 0;

const pendingTaskWrites = new Map<string, Task>();
let coalesceQueued = false;

type LogRow = { taskId: string; line: string };
let logBatch: LogRow[] = [];
let logBatchTimer: ReturnType<typeof setTimeout> | null = null;
let logBatchQueued = false;
const MAX_LOG_BATCH = 5_000;
/** flushPersist stops and reports failure if the queue is still busy after this many passes. */
const FLUSH_PERSIST_MAX_ROUNDS = 100;
let flushPersistMaxRounds = FLUSH_PERSIST_MAX_ROUNDS;
/** Test hook: runs after a log batch is accepted, before the queue is checked again. */
let afterLogInsertForTests: ((rows: LogRow[]) => void) | null = null;

function consumePersistFault(op: PersistOp): void {
  const idx = persistFaults.findIndex((f) => f.op === op);
  if (idx < 0) return;
  const err = persistFaults[idx]!.error;
  persistFaults.splice(idx, 1);
  throw err;
}

/** Queued fault injection for tests. Each call fails one later matching persist op. */
export function failNextPersistForTests(op: PersistOp, error = new Error("persist failed")): void {
  persistFaults.push({ op, error });
}

/** Skip Postgres inside queued persist jobs. Turns writes back on so the queue actually runs. */
export function setPersistDryRunForTests(on: boolean): void {
  persistDryRun = on;
  if (on) persistWrites = true;
}

/** Cap flushPersist rounds. `null` restores the production cap. */
export function setFlushPersistMaxRoundsForTests(rounds: number | null): void {
  flushPersistMaxRounds =
    rounds == null ? FLUSH_PERSIST_MAX_ROUNDS : Math.max(1, Math.trunc(rounds));
}

/** Invoked after a log batch is stored and before the flusher checks for more work. */
export function setAfterLogInsertForTests(fn: ((rows: LogRow[]) => void) | null): void {
  afterLogInsertForTests = fn;
}

export function persistQueueDepthForTests(): {
  logs: number;
  tasks: number;
  logQueued: boolean;
} {
  return {
    logs: logBatch.length,
    tasks: pendingTaskWrites.size,
    logQueued: logBatchQueued,
  };
}

export function isPersistDegraded(): boolean {
  return persistDegraded != null;
}

export function persistFailureMessage(): string | null {
  if (persistDegraded == null) return null;
  return persistDegraded instanceof Error ? persistDegraded.message : String(persistDegraded);
}

function asPersistError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return Object.assign(new Error(`persist failed: ${msg}`), { statusCode: 500, cause: err });
}

function clearDegradedIfRecovered(): void {
  if (failedTaskIds.size === 0 && !logPersistFailed) persistDegraded = null;
}

function enqueuePersist(job: () => Promise<void>): Promise<void> {
  if (!persistWrites) return Promise.resolve();
  if (persistDepth > 32) {
    console.warn(`[db] persist queue depth ${persistDepth}`);
  }
  persistDepth += 1;
  const run = persistChain.then(job);
  persistChain = run.then(
    () => {
      persistDepth = Math.max(0, persistDepth - 1);
      clearDegradedIfRecovered();
    },
    (err) => {
      persistDepth = Math.max(0, persistDepth - 1);
      console.error("[db] persist error:", err);
      persistDegraded = err;
      unreportedFailure = err;
    },
  );
  return run;
}

function kickTaskCoalesce(): void {
  if (!persistWrites || coalesceQueued || pendingTaskWrites.size === 0) return;
  const again = pendingTaskWrites.values().next().value;
  if (again) enqueueTaskCoalesced(again);
}

function enqueueTaskCoalesced(task: Task): void {
  if (!persistWrites) return;
  pendingTaskWrites.set(task.id, task);
  if (coalesceQueued) return;
  coalesceQueued = true;
  void enqueuePersist(async () => {
    coalesceQueued = false;
    const batch = [...pendingTaskWrites.entries()];
    pendingTaskWrites.clear();
    for (let i = 0; i < batch.length; i++) {
      const [id, t] = batch[i]!;
      try {
        await persistTask(t);
        failedTaskIds.delete(id);
      } catch (err) {
        if (!pendingTaskWrites.has(id)) pendingTaskWrites.set(id, t);
        for (const [id2, t2] of batch.slice(i + 1)) {
          if (!pendingTaskWrites.has(id2)) pendingTaskWrites.set(id2, t2);
          failedTaskIds.add(id2);
        }
        failedTaskIds.add(id);
        if (!taskRetryQueued) {
          taskRetryQueued = true;
          kickTaskCoalesce();
        }
        throw err;
      }
    }
    taskRetryQueued = false;
    if (pendingTaskWrites.size) kickTaskCoalesce();
  });
}

function dropQueuedLogs(ids: Set<string>): void {
  if (!ids.size) return;
  logBatch = logBatch.filter((row) => !ids.has(row.taskId));
}

function queueLogFlush(): void {
  if (logBatchTimer) {
    clearTimeout(logBatchTimer);
    logBatchTimer = null;
  }
  if (!logBatch.length || logBatchQueued || !persistWrites) return;
  logBatchQueued = true;
  void enqueuePersist(async () => {
    logBatchQueued = false;
    const rows = logBatch.splice(0, 200);
    if (!rows.length) return;
    try {
      await insertLogRows(rows);
      afterLogInsertForTests?.(rows);
      if (!logBatch.length) {
        logPersistFailed = false;
        logRetryQueued = false;
      }
    } catch (err) {
      logBatch = [...rows, ...logBatch];
      logPersistFailed = true;
      if (!logRetryQueued && logBatch.length) {
        logRetryQueued = true;
        queueLogFlush();
      }
      throw err;
    }
    const touched = new Set(rows.map((r) => r.taskId));
    for (const id of touched) await pruneTaskLogsInDb(id);
    if (logBatch.length) queueLogFlush();
  });
}

function enqueueLogLine(taskId: string, line: string): void {
  if (!persistWrites) return;
  if (logBatch.length >= MAX_LOG_BATCH) {
    const idx = logBatch.findIndex((row) => row.line && !row.line.includes('"type":"start"'));
    if (idx >= 0) logBatch.splice(idx, 1);
    else logBatch.shift();
    console.warn(`[db] log batch cap ${MAX_LOG_BATCH}; dropped an oldest queued line`);
  }
  logBatch.push({ taskId, line });
  if (!persistWrites) return;
  if (logBatch.length >= 50) {
    queueLogFlush();
    return;
  }
  if (logBatchTimer) return;
  logBatchTimer = setTimeout(() => {
    logBatchTimer = null;
    queueLogFlush();
  }, 30);
  logBatchTimer.unref?.();
}

function persistQueueIdle(seen: Promise<void>): boolean {
  return (
    seen === persistChain &&
    logBatch.length === 0 &&
    !logBatchQueued &&
    pendingTaskWrites.size === 0 &&
    !coalesceQueued
  );
}

export async function flushPersist(): Promise<void> {
  let drained = false;
  for (let i = 0; i < flushPersistMaxRounds; i++) {
    if (logBatch.length && !logBatchQueued) queueLogFlush();
    kickTaskCoalesce();
    const seen = persistChain;
    await seen;
    if (persistQueueIdle(seen)) {
      drained = true;
      break;
    }
  }
  if (!drained) {
    const pending = unreportedFailure;
    unreportedFailure = null;
    const why = pending instanceof Error ? pending.message : pending ? String(pending) : "";
    const rounds =
      flushPersistMaxRounds === 1 ? "1 round" : `${flushPersistMaxRounds} rounds`;
    const err = new Error(
      `flushPersist did not drain after ${rounds} (logs=${logBatch.length}, logQueued=${logBatchQueued}, tasks=${pendingTaskWrites.size}, taskQueued=${coalesceQueued})${why ? `: ${why}` : ""}`,
    );
    if (pending instanceof Error) err.cause = pending;
    throw err;
  }
  if (unreportedFailure) {
    const err = unreportedFailure;
    unreportedFailure = null;
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function iso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return String(v);
}

type WorkspaceRow = {
  id: string;
  name: string;
  path: string;
  created_at: Date | string;
  updated_at: Date | string;
  settings?: unknown;
};

type TaskRow = {
  id: string;
  title: string;
  kind: string;
  cwd: string;
  workspace_id: string | null;
  prompt: string;
  model: string | null;
  session_id: string | null;
  iteration: number;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  pid: number | null;
  summary: string | null;
  output: string | null;
  last_event: string | null;
  error: string | null;
  exit_code: number | null;
  attachments?: unknown;
  worktree?: unknown;
};

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    settings: normalizeWorkspaceSettings(row.settings),
  };
}


function parseAttachments(raw: unknown): Task["attachments"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<Task["attachments"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    if (!name) continue;
    out.push({
      name,
      originalName: typeof rec.originalName === "string" ? rec.originalName : name,
      url: typeof rec.url === "string" ? rec.url : `/uploads/${name}`,
      mime: typeof rec.mime === "string" ? rec.mime : "application/octet-stream",
      size: typeof rec.size === "number" ? rec.size : 0,
    });
  }
  return out.length ? out : undefined;
}

function parseWorktree(raw: unknown): Task["worktree"] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.owned !== true) return undefined;
  if (typeof rec.path !== "string" || !rec.path) return undefined;
  if (typeof rec.branch !== "string" || !rec.branch) return undefined;
  if (typeof rec.baseHead !== "string" || !rec.baseHead) return undefined;
  return {
    path: rec.path,
    branch: rec.branch,
    baseHead: rec.baseHead,
    owned: true,
  };
}

function rowToTask(
  row: TaskRow,
  outputs: OutputTurn[] | undefined,
  sideJobs: SideJob[] | undefined,
  prompts: PromptTurn[] | undefined,
): Task {
  return normalizeTask({
    id: row.id,
    title: row.title,
    kind: row.kind as Task["kind"],
    workspaceId: row.workspace_id || defaultWorkspaceId || "",
    cwd: row.cwd,
    prompt: row.prompt,
    model: row.model ?? undefined,
    sessionId: row.session_id ?? undefined,
    iteration: row.iteration,
    status: row.status as Task["status"],
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    startedAt: iso(row.started_at) ?? undefined,
    endedAt: iso(row.ended_at) ?? undefined,
    pid: row.pid ?? undefined,
    summary: row.summary ?? undefined,
    output: row.output ?? undefined,
    lastEvent: row.last_event ?? undefined,
    error: row.error ?? undefined,
    exitCode: row.exit_code,
    outputs: outputs?.length ? outputs : undefined,
    prompts: prompts?.length ? prompts : undefined,
    sideJobs: sideJobs?.length ? sideJobs : undefined,
    attachments: parseAttachments(row.attachments),
    worktree: parseWorktree(row.worktree),
  });
}

async function persistWorkspace(ws: Workspace): Promise<void> {
  consumePersistFault("workspace");
  const p = getPool();
  const settingsJson = ws.settings ? JSON.stringify(ws.settings) : null;
  await p.query(
    `INSERT INTO workspaces (id, name, path, created_at, updated_at, settings)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       path = EXCLUDED.path,
       updated_at = EXCLUDED.updated_at,
       settings = EXCLUDED.settings`,
    [ws.id, ws.name, ws.path, ws.createdAt, ws.updatedAt, settingsJson],
  );
}

async function persistDeleteWorkspaces(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const p = getPool();
  await p.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [ids]);
}

async function persistTask(task: Task): Promise<void> {
  consumePersistFault("task");
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tasks (
        id, title, kind, cwd, workspace_id, prompt, model, session_id, iteration, status,
        created_at, updated_at, started_at, ended_at, pid, summary, output,
        last_event, error, exit_code, attachments, worktree
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11::timestamptz,$12::timestamptz,$13::timestamptz,$14::timestamptz,$15,$16,$17,
        $18,$19,$20,$21::jsonb,$22::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        kind = EXCLUDED.kind,
        cwd = EXCLUDED.cwd,
        workspace_id = EXCLUDED.workspace_id,
        prompt = EXCLUDED.prompt,
        model = EXCLUDED.model,
        session_id = EXCLUDED.session_id,
        iteration = EXCLUDED.iteration,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        pid = EXCLUDED.pid,
        summary = EXCLUDED.summary,
        output = EXCLUDED.output,
        last_event = EXCLUDED.last_event,
        error = EXCLUDED.error,
        exit_code = EXCLUDED.exit_code,
        attachments = EXCLUDED.attachments,
        worktree = EXCLUDED.worktree`,
      [
        task.id,
        task.title,
        task.kind,
        task.cwd,
        task.workspaceId || null,
        task.prompt,
        task.model ?? null,
        task.sessionId ?? null,
        task.iteration,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.startedAt ?? null,
        task.endedAt ?? null,
        task.pid ?? null,
        task.summary ?? null,
        task.output ?? null,
        task.lastEvent ?? null,
        task.error ?? null,
        task.exitCode ?? null,
        JSON.stringify(task.attachments || []),
        task.worktree ? JSON.stringify(task.worktree) : null,
      ],
    );

    await client.query(`DELETE FROM task_outputs WHERE task_id = $1`, [task.id]);
    for (const o of task.outputs || []) {
      await client.query(
        `INSERT INTO task_outputs (task_id, iteration, text, at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [task.id, o.iteration, o.text, o.at ?? null],
      );
    }

    await client.query(`DELETE FROM task_prompts WHERE task_id = $1`, [task.id]);
    for (const pr of task.prompts || []) {
      await client.query(
        `INSERT INTO task_prompts (task_id, iteration, prompt, at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [task.id, pr.iteration, pr.prompt, pr.at ?? null],
      );
    }

    await client.query(`DELETE FROM task_side_jobs WHERE task_id = $1`, [task.id]);
    for (const j of task.sideJobs || []) {
      await client.query(
        `INSERT INTO task_side_jobs (
          task_id, job_id, kind, title, summary, status, tool_name, started_at, ended_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)`,
        [
          task.id,
          j.id,
          j.kind,
          j.title,
          j.summary ?? null,
          j.status,
          j.toolName ?? null,
          j.startedAt ?? null,
          j.endedAt ?? null,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function persistDelete(ids: string[]): Promise<void> {
  if (!ids.length) return;
  consumePersistFault("delete");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Explicit child deletes (FK also has ON DELETE CASCADE — belt and suspenders).
    await client.query(`DELETE FROM task_logs WHERE task_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM task_outputs WHERE task_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM task_prompts WHERE task_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM task_side_jobs WHERE task_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM tasks WHERE id = ANY($1::text[])`, [ids]);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
  for (const id of ids) {
    try {
      const path = `${logsDir()}/${id}.jsonl`;
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      console.warn(`[db] could not remove log file for ${id}:`, err);
    }
  }
}

/** How often to prune Postgres rows for a task after append (amortize DELETE cost). */
const LOG_DB_PRUNE_EVERY = 50;

async function pruneTaskLogsInDb(
  taskId: string,
  keep = MAX_LOG_LINES_KEPT,
  maxChars = MAX_LOG_CHARS_KEPT,
): Promise<void> {
  if (persistDryRun) return;
  if (keep <= 0 || maxChars <= 0) {
    await getPool().query(`DELETE FROM task_logs WHERE task_id = $1`, [taskId]);
    return;
  }
  const p = getPool();
  const countRes = await p.query<{ n: string; c: string }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(char_length(line)), 0)::text AS c
     FROM task_logs WHERE task_id = $1`,
    [taskId],
  );
  const n = Number(countRes.rows[0]?.n || 0);
  const chars = Number(countRes.rows[0]?.c || 0);
  if (n <= keep && chars <= maxChars) return;

  // Bound a legacy backlog before the exact in-memory selection: keep the
  // newest `keep` rows plus older meta-like lines, fixing the old OFFSET off-by-one.
  if (n > keep + LOG_DB_PRUNE_EVERY) {
    await p.query(
      `DELETE FROM task_logs AS t
       WHERE t.task_id = $1
         AND t.id < (
           SELECT id FROM task_logs
           WHERE task_id = $1
           ORDER BY id DESC
           OFFSET $2
           LIMIT 1
         )
         AND NOT (t.line ~ $3)`,
      [taskId, keep - 1, boardMetaLineSqlPattern()],
    );
  }

  const res = await p.query<{ id: string; line: string }>(
    `SELECT id, line FROM task_logs WHERE task_id = $1 ORDER BY id ASC`,
    [taskId],
  );
  if (res.rows.length <= keep && chars <= maxChars) {
    const total = res.rows.reduce((sum, row) => sum + row.line.length, 0);
    if (res.rows.length <= keep && total <= maxChars) return;
  }
  const indices = keptLogIndices(
    res.rows.map((r) => r.line),
    keep,
    maxChars,
  );
  const keepIds = new Set(indices.map((i) => res.rows[i]!.id));
  const dropIds = res.rows.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
  if (!dropIds.length) return;
  await p.query(`DELETE FROM task_logs WHERE task_id = $1 AND id = ANY($2::bigint[])`, [
    taskId,
    dropIds,
  ]);
}

/** Test hook: run the same prune the append path uses, with an explicit cap. */
export async function pruneTaskLogsForTests(
  taskId: string,
  keep: number,
  maxChars = MAX_LOG_CHARS_KEPT,
): Promise<void> {
  await pruneTaskLogsInDb(taskId, keep, maxChars);
}

async function insertLogRows(rows: LogRow[]): Promise<void> {
  if (!rows.length) return;
  consumePersistFault("log");
  if (persistDryRun) return;
  await getPool().query(
    `INSERT INTO task_logs (task_id, line)
     SELECT * FROM UNNEST($1::text[], $2::text[])`,
    [rows.map((r) => r.taskId), rows.map((r) => r.line)],
  );
}

async function persistLogLine(taskId: string, line: string): Promise<void> {
  await insertLogRows([{ taskId, line }]);
  await pruneTaskLogsInDb(taskId);
}

async function loadWorkspacesFromPg(): Promise<void> {
  const p = getPool();
  const res = await p.query<WorkspaceRow>(
    `SELECT * FROM workspaces ORDER BY created_at ASC`,
  );
  workspaces = new Map();
  for (const row of res.rows) {
    const ws = rowToWorkspace(row);
    workspaces.set(ws.id, ws);
  }
}

async function loadAllFromPg(): Promise<void> {
  await loadWorkspacesFromPg();
  const p = getPool();
  const taskRes = await p.query<TaskRow>(`SELECT * FROM tasks ORDER BY created_at DESC`);
  const outRes = await p.query<{
    task_id: string;
    iteration: number;
    text: string;
    at: Date | string | null;
  }>(`SELECT task_id, iteration, text, at FROM task_outputs ORDER BY iteration ASC`);
  const promptRes = await p.query<{
    task_id: string;
    iteration: number;
    prompt: string;
    at: Date | string | null;
  }>(`SELECT task_id, iteration, prompt, at FROM task_prompts ORDER BY iteration ASC`);
  const sideRes = await p.query<{
    task_id: string;
    job_id: string;
    kind: string;
    title: string;
    summary: string | null;
    status: string;
    tool_name: string | null;
    started_at: Date | string | null;
    ended_at: Date | string | null;
  }>(`SELECT * FROM task_side_jobs`);

  const outputsBy = new Map<string, OutputTurn[]>();
  for (const r of outRes.rows) {
    const list = outputsBy.get(r.task_id) || [];
    list.push({
      iteration: r.iteration,
      text: r.text,
      at: iso(r.at),
    });
    outputsBy.set(r.task_id, list);
  }

  const promptsBy = new Map<string, PromptTurn[]>();
  for (const r of promptRes.rows) {
    const list = promptsBy.get(r.task_id) || [];
    list.push({
      iteration: r.iteration,
      prompt: r.prompt,
      at: iso(r.at),
    });
    promptsBy.set(r.task_id, list);
  }

  const sidesBy = new Map<string, SideJob[]>();
  for (const r of sideRes.rows) {
    const list = sidesBy.get(r.task_id) || [];
    list.push({
      id: r.job_id,
      kind: r.kind as SideJob["kind"],
      title: r.title,
      summary: r.summary ?? undefined,
      status: r.status as SideJob["status"],
      toolName: r.tool_name ?? undefined,
      startedAt: iso(r.started_at),
      endedAt: iso(r.ended_at),
    });
    sidesBy.set(r.task_id, list);
  }

  tasks = new Map();
  for (const row of taskRes.rows) {
    const t = rowToTask(row, outputsBy.get(row.id), sidesBy.get(row.id), promptsBy.get(row.id));
    tasks.set(t.id, t);
  }

  // Do NOT load every historical task_logs row — chatty agents can leave 100k+/task
  // and a full SELECT + per-row trim stalls listen for minutes at 100% CPU.
  // Load only the newest MAX_LOG_LINES_KEPT lines per task (meta kept via trim).
  logs = new Map();
  const logRes = await p.query<{ task_id: string; line: string }>(
    `SELECT task_id, line, id FROM (
       SELECT task_id, line, id,
              ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS rn
       FROM task_logs
     ) t
     WHERE rn <= $1
        OR line ~ $2
     ORDER BY task_id ASC, id ASC`,
    [MAX_LOG_LINES_KEPT + LOG_DB_PRUNE_EVERY, boardMetaLineSqlPattern()],
  );
  for (const r of logRes.rows) {
    const arr = logs.get(r.task_id) || [];
    // Same bound as live appendLog. A mid-string cut would make reload
    // extraction disagree with the line that was stored.
    arr.push(boundStoredLogLine(r.line));
    logs.set(r.task_id, arr);
  }
  for (const arr of logs.values()) {
    trimLogsKeepingMeta(arr);
  }
}

async function migrateFromJsonIfNeeded(): Promise<void> {
  const p = getPool();
  const flag = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = 'migrated_from_json'`,
  );
  if (flag.rows[0]?.value === "1") return;
  if (!jsonDbExists()) {
    await p.query(
      `INSERT INTO meta (key, value) VALUES ('migrated_from_json', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`,
    );
    return;
  }

  const raw = readJsonDbRaw();
  const list = Array.isArray(raw?.tasks) ? (raw!.tasks as Task[]) : [];
  console.log(`[db] migrating ${list.length} tasks from data/db.json …`);

  for (const item of list) {
    const t = normalizeTask({
      ...item,
      workspaceId: item.workspaceId || defaultWorkspaceId || "",
    });
    tasks.set(t.id, t);
    await persistTask(t);
  }

  for (const { id, path } of listJsonlLogFiles()) {
    if (!tasks.has(id) && !list.some((t) => t.id === id)) {
      continue;
    }
    try {
      const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
      logs.set(id, lines);
      for (const line of lines) {
        await persistLogLine(id, line);
      }
      console.log(`[db] migrated ${lines.length} log lines for ${id}`);
    } catch (err) {
      console.warn(`[db] skip log ${id}:`, err);
    }
  }

  await p.query(
    `INSERT INTO meta (key, value) VALUES ('migrated_from_json', '1')
     ON CONFLICT (key) DO UPDATE SET value = '1'`,
  );
  archiveJsonDb();
  console.log("[db] JSON migration complete");
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDefaultWorkspace(): Promise<void> {
  const p = getPool();
  await loadWorkspacesFromPg();

  const meta = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = 'default_workspace_id'`,
  );
  let id = meta.rows[0]?.value;
  if (id && workspaces.has(id)) {
    defaultWorkspaceId = id;
  } else if (workspaces.size) {
    // Prefer existing first workspace
    defaultWorkspaceId = [...workspaces.values()][0].id;
    await p.query(
      `INSERT INTO meta (key, value) VALUES ('default_workspace_id', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [defaultWorkspaceId],
    );
  } else {
    const home = homedir() || "/home/menghongfei";
    const defaultPath = existsSync(`${home}/projects/agent-board`)
      ? `${home}/projects/agent-board`
      : home;
    const ws: Workspace = {
      id: nanoid(10),
      name: "默认工作区",
      path: defaultPath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    workspaces.set(ws.id, ws);
    await persistWorkspace(ws);
    defaultWorkspaceId = ws.id;
    await p.query(
      `INSERT INTO meta (key, value) VALUES ('default_workspace_id', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [ws.id],
    );
    console.log(`[db] created default workspace ${ws.id} → ${ws.path}`);
  }

  // Attach orphan tasks to default workspace
  const orphan = await p.query(
    `UPDATE tasks SET workspace_id = $1 WHERE workspace_id IS NULL`,
    [defaultWorkspaceId],
  );
  if ((orphan.rowCount || 0) > 0) {
    console.log(`[db] migrated ${orphan.rowCount} tasks → default workspace`);
  }
}

/** Leftover queued/running/blocked rows are not reattached to child processes. */
async function reconcileInterruptedTasks(): Promise<number> {
  let n = 0;
  const nowIso = new Date().toISOString();
  for (const t of [...tasks.values()]) {
    if (t.status !== "queued" && t.status !== "running" && t.status !== "blocked") continue;
    const endedAt = t.endedAt || nowIso;
    const sideJobs = finalizeRunningSideJobs(t.sideJobs, endedAt, "failed") ?? t.sideJobs;
    const next: Task = {
      ...t,
      status: "failed",
      error: t.error || "服务重启，任务已中断（未接管子进程）",
      lastEvent: "interrupted",
      pid: undefined,
      endedAt,
      updatedAt: nowIso,
      sideJobs,
    };
    tasks.set(t.id, next);
    await persistTask(next);
    n += 1;
  }
  return n;
}

function referencedUploadNames(): Set<string> {
  return collectUploadRefs(tasks.values());
}

/** Call once before serving HTTP. */
export async function initStore(): Promise<void> {
  if (ready) return;
  ensureDataDirs();
  await ensureSchema();
  await ensureDefaultWorkspace();
  await migrateFromJsonIfNeeded();
  // Re-ensure after JSON migration in case new tasks lacked workspace
  await ensureDefaultWorkspace();
  await loadAllFromPg();
  await loadCliPathOverrides();
  await loadProxyEnvOverrides();
  await loadQuickPrompts();
  await loadCodexSandbox();
  // Patch in-memory tasks missing workspaceId
  for (const [id, t] of tasks) {
    if (!t.workspaceId && defaultWorkspaceId) {
      const next = { ...t, workspaceId: defaultWorkspaceId };
      tasks.set(id, next);
      enqueuePersist(() => persistTask(next));
    }
  }
  const purged = await purgeOrphanLogs();
  if (purged.pgRows || purged.jsonlFiles) {
    console.log(
      `[db] purged orphan logs: pgRows=${purged.pgRows} jsonlFiles=${purged.jsonlFiles} jsonlBytes=${purged.jsonlBytes}`,
    );
  }
  const archivedLogs = await purgeArchivedTaskLogs();
  if (archivedLogs.rows) {
    console.log(
      `[db] purged archived task_logs: tasks=${archivedLogs.tasks} rows=${archivedLogs.rows}`,
    );
  }
  const interrupted = await reconcileInterruptedTasks();
  if (interrupted) {
    console.log(`[db] marked ${interrupted} leftover running task(s) interrupted`);
  }
  try {
    const gc = await gcOrphanUploads(referencedUploadNames());
    if (gc) console.log(`[uploads] gc ${gc} unreferenced file(s)`);
  } catch (err) {
    console.warn("[uploads] gc failed:", err);
  }

  ready = true;
  console.log(
    `[db] ready · ${workspaces.size} workspaces · ${tasks.size} tasks · ${redactDatabaseUrl()}`,
  );
}


export function listWorkspaces(): Workspace[] {
  return [...workspaces.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getWorkspace(id: string): Workspace | undefined {
  return workspaces.get(id);
}

export function getDefaultWorkspaceId(): string {
  if (!defaultWorkspaceId) throw new Error("default workspace not ready");
  return defaultWorkspaceId;
}

export async function upsertWorkspace(ws: Workspace): Promise<Workspace> {
  const prev = workspaces.get(ws.id);
  workspaces.set(ws.id, ws);
  try {
    await enqueuePersist(() => persistWorkspace(ws));
  } catch (err) {
    if (prev) workspaces.set(ws.id, prev);
    else workspaces.delete(ws.id);
    throw asPersistError(err);
  }
  return ws;
}

export async function deleteWorkspace(id: string): Promise<boolean> {
  if (!workspaces.has(id)) return false;
  if (id === defaultWorkspaceId) {
    throw new Error("cannot delete the default workspace");
  }
  for (const t of tasks.values()) {
    if (t.workspaceId === id) {
      throw new Error("workspace still has tasks; move or delete them first");
    }
  }
  try {
    await enqueuePersist(() => persistDeleteWorkspaces([id]));
  } catch (err) {
    throw asPersistError(err);
  }
  workspaces.delete(id);
  return true;
}

export function listTasks(workspaceId?: string): Task[] {
  let list = [...tasks.values()].map(normalizeTask);
  if (workspaceId) list = list.filter((t) => t.workspaceId === workspaceId);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTask(id: string): Task | undefined {
  const t = tasks.get(id);
  return t ? normalizeTask(t) : undefined;
}

export function upsertTask(task: Task): Task {
  const normalized = normalizeTask(task);
  tasks.set(normalized.id, normalized);
  enqueueTaskCoalesced(normalized);
  return normalized;
}

/** Test hook: the next saveTaskDurable calls await this promise first. */
export function setDurableDelayForTests(p: Promise<void> | null): void {
  durableDelay = p;
}

export function durableWaiterCountForTests(): number {
  return durableWaiters;
}

/** Wait until this snapshot is committed. Rolls memory back if the write fails. */
export async function saveTaskDurable(task: Task): Promise<Task> {
  const pendingDelay = durableDelay;
  if (pendingDelay) {
    durableWaiters += 1;
    try {
      await pendingDelay;
    } finally {
      durableWaiters -= 1;
    }
  }
  const normalized = normalizeTask(task);
  const prev = tasks.get(normalized.id);
  tasks.set(normalized.id, normalized);
  try {
    await enqueuePersist(() => persistTask(normalized));
  } catch (err) {
    if (tasks.get(normalized.id) === normalized) {
      if (prev) tasks.set(normalized.id, prev);
      else tasks.delete(normalized.id);
    }
    throw asPersistError(err);
  }
  return normalized;
}

export async function deleteTasks(ids: string[]): Promise<string[]> {
  const removed = ids.filter((id) => tasks.has(id));
  if (!removed.length) return [];
  // Disarm deferred work before the await so a timer cannot rewrite the row.
  tasksDeletedListener?.(removed);
  try {
    if (persistWrites) await enqueuePersist(() => persistDelete(removed));
  } catch (err) {
    throw asPersistError(err);
  }
  for (const id of removed) {
    tasks.delete(id);
    logs.delete(id);
  }
  dropQueuedLogs(new Set(removed));
  return removed;
}

/** @deprecated file path kept for callers; logs live in Postgres */
export function logPath(id: string) {
  return `${logsDir()}/${id}.jsonl`;
}

export function appendLog(id: string, line: string): void {
  const cleaned = boundStoredLogLine(line);
  const arr = logs.get(id) || [];
  arr.push(cleaned);
  trimLogsKeepingMeta(arr);
  logs.set(id, arr);
  enqueueLogLine(id, cleaned);
}

export function logLineCount(id: string): number {
  return (logs.get(id) || []).length;
}

export function readLogTail(
  id: string,
  maxLines = DEFAULT_LOG_TAIL_LINES,
  maxTotalChars = DEFAULT_LOG_TAIL_CHARS,
): string[] {
  const arr = logs.get(id) || [];
  const slice = arr.slice(-Math.max(1, maxLines)).map((l) => truncateLogLine(l));
  let total = 0;
  const out: string[] = [];
  for (let i = slice.length - 1; i >= 0; i--) {
    const line = slice[i];
    if (out.length && total + line.length > maxTotalChars) break;
    out.push(line);
    total += line.length;
  }
  out.reverse();
  return out;
}

export function removeLog(id: string): void {
  logs.delete(id);
  dropQueuedLogs(new Set([id]));
  enqueuePersist(async () => {
    await getPool().query(`DELETE FROM task_logs WHERE task_id = $1`, [id]);
    try {
      const path = `${logsDir()}/${id}.jsonl`;
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      console.warn(`[db] could not remove log file for ${id}:`, err);
    }
  });
}

/** Drop task_logs only (memory + PG + jsonl). Keeps prompts/outputs/sideJobs. */
export function clearTaskLogs(ids: string[]): void {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return;
  for (const id of uniq) logs.delete(id);
  dropQueuedLogs(new Set(uniq));
  enqueuePersist(async () => {
    await getPool().query(`DELETE FROM task_logs WHERE task_id = ANY($1::text[])`, [uniq]);
    for (const id of uniq) {
      try {
        const path = `${logsDir()}/${id}.jsonl`;
        if (existsSync(path)) unlinkSync(path);
      } catch (err) {
        console.warn(`[db] could not remove log file for ${id}:`, err);
      }
    }
  });
}

/** Clear task_logs for every archived task (prompts/outputs retained). */
export async function purgeArchivedTaskLogs(): Promise<{ tasks: number; rows: number }> {
  const p = getPool();
  const ids = [...tasks.values()].filter((t) => t.status === "archived").map((t) => t.id);
  if (!ids.length) return { tasks: 0, rows: 0 };
  for (const id of ids) logs.delete(id);
  const del = await p.query(
    `DELETE FROM task_logs WHERE task_id = ANY($1::text[]) RETURNING id`,
    [ids],
  );
  for (const id of ids) {
    try {
      const path = `${logsDir()}/${id}.jsonl`;
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      console.warn(`[db] could not remove log file for ${id}:`, err);
    }
  }
  return { tasks: ids.length, rows: del.rowCount ?? del.rows.length };
}

/** Drop PG + jsonl logs whose task row is already gone (legacy leftovers). */
export async function purgeOrphanLogs(): Promise<{
  pgRows: number;
  jsonlFiles: number;
  jsonlBytes: number;
}> {
  const p = getPool();
  const del = await p.query(
    `WITH doomed AS (
       SELECT id FROM task_logs l
       WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = l.task_id)
     )
     DELETE FROM task_logs WHERE id IN (SELECT id FROM doomed)
     RETURNING id`,
  );
  const pgRows = del.rowCount ?? del.rows.length;

  let jsonlFiles = 0;
  let jsonlBytes = 0;
  const orphanLogsDir = logsDir();
  if (existsSync(orphanLogsDir)) {
    for (const f of readdirSync(orphanLogsDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.replace(/\.jsonl$/, "");
      if (tasks.has(id)) continue;
      const path = `${orphanLogsDir}/${f}`;
      try {
        jsonlBytes += statSync(path).size;
        unlinkSync(path);
        jsonlFiles += 1;
      } catch (err) {
        console.warn(`[db] could not purge orphan log ${f}:`, err);
      }
    }
  }
  return { pgRows, jsonlFiles, jsonlBytes };
}

export function isStoreReady(): boolean {
  return ready;
}

export function countTasksInWorkspace(workspaceId: string): number {
  let n = 0;
  for (const t of tasks.values()) {
    if (t.workspaceId === workspaceId) n++;
  }
  return n;
}


/**
 * Unit tests: in-memory tasks/workspaces and no Postgres writes.
 * Returns the seeded default workspace id.
 */
function resetPersistTestHooks(): void {
  persistDryRun = false;
  afterLogInsertForTests = null;
  flushPersistMaxRounds = FLUSH_PERSIST_MAX_ROUNDS;
  if (logBatchTimer) {
    clearTimeout(logBatchTimer);
    logBatchTimer = null;
  }
  logBatchQueued = false;
  coalesceQueued = false;
}

export function enableMemoryStoreForTests(): string {
  resetPersistTestHooks();
  persistWrites = false;
  persistFaults = [];
  persistDegraded = null;
  unreportedFailure = null;
  failedTaskIds.clear();
  logPersistFailed = false;
  logRetryQueued = false;
  taskRetryQueued = false;
  durableDelay = null;
  durableWaiters = 0;
  tasks = new Map();
  workspaces = new Map();
  logs = new Map();
  logBatch = [];
  pendingTaskWrites.clear();
  const now = new Date().toISOString();
  const ws: Workspace = {
    id: "ws-memory-test",
    name: "memory",
    path: "/tmp/agent-board-memory-test",
    createdAt: now,
    updatedAt: now,
  };
  mkdirSync(ws.path, { recursive: true });
  workspaces.set(ws.id, ws);
  defaultWorkspaceId = ws.id;
  ready = true;
  return ws.id;
}

/** Undo enableMemoryStoreForTests. Does not touch an open Postgres pool. */
export function disableMemoryStoreForTests(): void {
  resetPersistTestHooks();
  persistWrites = true;
  tasks = new Map();
  workspaces = new Map();
  logs = new Map();
  logBatch = [];
  pendingTaskWrites.clear();
  defaultWorkspaceId = null;
  ready = false;
}

/** Integration tests: wipe PG + memory and re-init (keeps same DATABASE_URL pool). */
export async function resetStoreForTests(): Promise<void> {
  persistFaults = [];
  unreportedFailure = null;
  persistDegraded = null;
  failedTaskIds.clear();
  logPersistFailed = false;
  logRetryQueued = false;
  taskRetryQueued = false;
  durableDelay = null;
  durableWaiters = 0;
  try {
    await flushPersist();
  } catch (err) {
    console.error("[db] flush before test reset:", err);
  }
  unreportedFailure = null;
  persistDegraded = null;
  logBatch = [];
  pendingTaskWrites.clear();
  const p = getPool();
  await p.query(
    `TRUNCATE task_logs, task_outputs, task_prompts, task_side_jobs, tasks, uploads, workspaces, meta RESTART IDENTITY CASCADE`,
  );
  tasks = new Map();
  workspaces = new Map();
  logs = new Map();
  defaultWorkspaceId = null;
  ready = false;
  await initStore();
}

export { closePool, getPool };
