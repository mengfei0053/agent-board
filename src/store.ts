import { existsSync, readFileSync } from "node:fs";
import type { OutputTurn, SideJob, Task } from "./types.js";
import {
  archiveJsonDb,
  dataDir,
  ensureSchema,
  getPool,
  jsonDbExists,
  listJsonlLogFiles,
  logsDir,
  readJsonDbRaw,
} from "./db.js";

export { dataDir, logsDir };

/** In-memory mirror for sync reads; Postgres is the source of truth after init. */
let tasks = new Map<string, Task>();
let logs = new Map<string, string[]>();
let ready = false;
let persistChain: Promise<void> = Promise.resolve();

function normalizeTask(t: Task): Task {
  return {
    ...t,
    iteration: typeof t.iteration === "number" && t.iteration >= 1 ? t.iteration : 1,
  };
}

function enqueuePersist(job: () => Promise<void>): void {
  persistChain = persistChain.then(job).catch((err) => {
    console.error("[db] persist error:", err);
  });
}

export async function flushPersist(): Promise<void> {
  await persistChain;
}

function iso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return String(v);
}

type TaskRow = {
  id: string;
  title: string;
  kind: string;
  cwd: string;
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
};

function rowToTask(
  row: TaskRow,
  outputs: OutputTurn[] | undefined,
  sideJobs: SideJob[] | undefined,
): Task {
  return normalizeTask({
    id: row.id,
    title: row.title,
    kind: row.kind as Task["kind"],
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
    sideJobs: sideJobs?.length ? sideJobs : undefined,
  });
}

async function persistTask(task: Task): Promise<void> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tasks (
        id, title, kind, cwd, prompt, model, session_id, iteration, status,
        created_at, updated_at, started_at, ended_at, pid, summary, output,
        last_event, error, exit_code
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        $10::timestamptz,$11::timestamptz,$12::timestamptz,$13::timestamptz,$14,$15,$16,
        $17,$18,$19
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        kind = EXCLUDED.kind,
        cwd = EXCLUDED.cwd,
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
        exit_code = EXCLUDED.exit_code`,
      [
        task.id,
        task.title,
        task.kind,
        task.cwd,
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
  const p = getPool();
  await p.query(`DELETE FROM tasks WHERE id = ANY($1::text[])`, [ids]);
}

async function persistLogLine(taskId: string, line: string): Promise<void> {
  const p = getPool();
  await p.query(`INSERT INTO task_logs (task_id, line) VALUES ($1, $2)`, [taskId, line]);
}

async function loadAllFromPg(): Promise<void> {
  const p = getPool();
  const taskRes = await p.query<TaskRow>(`SELECT * FROM tasks ORDER BY created_at DESC`);
  const outRes = await p.query<{
    task_id: string;
    iteration: number;
    text: string;
    at: Date | string | null;
  }>(`SELECT task_id, iteration, text, at FROM task_outputs ORDER BY iteration ASC`);
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
    const t = rowToTask(row, outputsBy.get(row.id), sidesBy.get(row.id));
    tasks.set(t.id, t);
  }

  logs = new Map();
  const logRes = await p.query<{ task_id: string; line: string }>(
    `SELECT task_id, line FROM task_logs ORDER BY id ASC`,
  );
  for (const r of logRes.rows) {
    const arr = logs.get(r.task_id) || [];
    arr.push(r.line);
    logs.set(r.task_id, arr);
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
    const t = normalizeTask(item);
    tasks.set(t.id, t);
    await persistTask(t);
  }

  for (const { id, path } of listJsonlLogFiles()) {
    if (!tasks.has(id) && !list.some((t) => t.id === id)) {
      // orphan log — still import if we later need; skip without task FK
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

/** Call once before serving HTTP. */
export async function initStore(): Promise<void> {
  if (ready) return;
  await ensureSchema();
  await migrateFromJsonIfNeeded();
  await loadAllFromPg();
  ready = true;
  console.log(`[db] ready · ${tasks.size} tasks · ${databaseUrlRedacted()}`);
}

function databaseUrlRedacted(): string {
  try {
    const u = new URL(process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/agent_board");
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(DATABASE_URL)";
  }
}

export function listTasks(): Task[] {
  return [...tasks.values()]
    .map(normalizeTask)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTask(id: string): Task | undefined {
  const t = tasks.get(id);
  return t ? normalizeTask(t) : undefined;
}

export function upsertTask(task: Task): Task {
  const normalized = normalizeTask(task);
  tasks.set(normalized.id, normalized);
  enqueuePersist(() => persistTask(normalized));
  return normalized;
}

export function deleteTasks(ids: string[]): string[] {
  const removed: string[] = [];
  for (const id of ids) {
    if (tasks.delete(id)) {
      removed.push(id);
      logs.delete(id);
    }
  }
  if (removed.length) enqueuePersist(() => persistDelete(removed));
  return removed;
}

/** @deprecated file path kept for callers; logs live in Postgres */
export function logPath(id: string) {
  return `${logsDir}/${id}.jsonl`;
}

export function appendLog(id: string, line: string): void {
  const cleaned = line.endsWith("\n") ? line.slice(0, -1) : line;
  const arr = logs.get(id) || [];
  arr.push(cleaned);
  logs.set(id, arr);
  enqueuePersist(() => persistLogLine(id, cleaned));
}

export function readLogTail(id: string, maxLines = 400): string[] {
  const arr = logs.get(id) || [];
  return arr.slice(-maxLines);
}

export function removeLog(id: string): void {
  logs.delete(id);
  enqueuePersist(async () => {
    await getPool().query(`DELETE FROM task_logs WHERE task_id = $1`, [id]);
  });
}

export function isStoreReady(): boolean {
  return ready;
}
