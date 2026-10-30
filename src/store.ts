import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import type { OutputTurn, SideJob, Task, Workspace } from "./types.js";
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
import { loadCliPathOverrides } from "./cliPaths.js";

export { dataDir, logsDir };

/** In-memory mirror for sync reads; Postgres is the source of truth after init. */
let tasks = new Map<string, Task>();
let workspaces = new Map<string, Workspace>();
let logs = new Map<string, string[]>();

/** Cap a single log line — agent_end / tool dumps can be multi-MB JSON. */
export const MAX_LOG_LINE_CHARS = 8_000;
/** Soft cap for in-memory lines kept per task. */
export const MAX_LOG_LINES_KEPT = 3_000;
/** UI/API default: last N lines. */
export const DEFAULT_LOG_TAIL_LINES = 400;
/** UI/API default: total chars across returned lines. */
export const DEFAULT_LOG_TAIL_CHARS = 240_000;

export function truncateLogLine(line: string, maxChars = MAX_LOG_LINE_CHARS): string {
  if (line.length <= maxChars) return line;
  const omitted = line.length - maxChars;
  return `${line.slice(0, maxChars)}…[truncated ${omitted} chars]`;
}


let ready = false;
let persistChain: Promise<void> = Promise.resolve();
let defaultWorkspaceId: string | null = null;

function normalizeTask(t: Task): Task {
  return {
    ...t,
    iteration: typeof t.iteration === "number" && t.iteration >= 1 ? t.iteration : 1,
    workspaceId: t.workspaceId || defaultWorkspaceId || "",
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

type WorkspaceRow = {
  id: string;
  name: string;
  path: string;
  created_at: Date | string;
  updated_at: Date | string;
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
};

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function rowToTask(
  row: TaskRow,
  outputs: OutputTurn[] | undefined,
  sideJobs: SideJob[] | undefined,
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
    sideJobs: sideJobs?.length ? sideJobs : undefined,
  });
}

async function persistWorkspace(ws: Workspace): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO workspaces (id, name, path, created_at, updated_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       path = EXCLUDED.path,
       updated_at = EXCLUDED.updated_at`,
    [ws.id, ws.name, ws.path, ws.createdAt, ws.updatedAt],
  );
}

async function persistDeleteWorkspaces(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const p = getPool();
  await p.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [ids]);
}

async function persistTask(task: Task): Promise<void> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tasks (
        id, title, kind, cwd, workspace_id, prompt, model, session_id, iteration, status,
        created_at, updated_at, started_at, ended_at, pid, summary, output,
        last_event, error, exit_code
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11::timestamptz,$12::timestamptz,$13::timestamptz,$14::timestamptz,$15,$16,$17,
        $18,$19,$20
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
        exit_code = EXCLUDED.exit_code`,
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
    arr.push(truncateLogLine(r.line));
    if (arr.length > MAX_LOG_LINES_KEPT) {
      arr.splice(0, arr.length - MAX_LOG_LINES_KEPT);
    }
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

/** Call once before serving HTTP. */
export async function initStore(): Promise<void> {
  if (ready) return;
  await ensureSchema();
  await ensureDefaultWorkspace();
  await migrateFromJsonIfNeeded();
  // Re-ensure after JSON migration in case new tasks lacked workspace
  await ensureDefaultWorkspace();
  await loadAllFromPg();
  await loadCliPathOverrides();
  // Patch in-memory tasks missing workspaceId
  for (const [id, t] of tasks) {
    if (!t.workspaceId && defaultWorkspaceId) {
      const next = { ...t, workspaceId: defaultWorkspaceId };
      tasks.set(id, next);
      enqueuePersist(() => persistTask(next));
    }
  }
  ready = true;
  console.log(
    `[db] ready · ${workspaces.size} workspaces · ${tasks.size} tasks · ${databaseUrlRedacted()}`,
  );
}

function databaseUrlRedacted(): string {
  try {
    const u = new URL(
      process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/agent_board",
    );
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(DATABASE_URL)";
  }
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

export function upsertWorkspace(ws: Workspace): Workspace {
  workspaces.set(ws.id, ws);
  enqueuePersist(() => persistWorkspace(ws));
  return ws;
}

export function deleteWorkspace(id: string): boolean {
  if (!workspaces.has(id)) return false;
  if (id === defaultWorkspaceId) {
    throw new Error("cannot delete the default workspace");
  }
  for (const t of tasks.values()) {
    if (t.workspaceId === id) {
      throw new Error("workspace still has tasks; move or delete them first");
    }
  }
  workspaces.delete(id);
  enqueuePersist(() => persistDeleteWorkspaces([id]));
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
  const cleaned = truncateLogLine(line.endsWith("\n") ? line.slice(0, -1) : line);
  const arr = logs.get(id) || [];
  arr.push(cleaned);
  if (arr.length > MAX_LOG_LINES_KEPT) {
    arr.splice(0, arr.length - MAX_LOG_LINES_KEPT);
  }
  logs.set(id, arr);
  enqueuePersist(() => persistLogLine(id, cleaned));
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
  enqueuePersist(async () => {
    await getPool().query(`DELETE FROM task_logs WHERE task_id = $1`, [id]);
  });
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
