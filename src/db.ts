import pg from "pg";
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = join(root, "data");
export const logsDir = join(dataDir, "logs");
export const jsonDbPath = join(dataDir, "db.json");

mkdirSync(logsDir, { recursive: true });

/** Default points at the ThinkBook docker postgres:16 container on :5432 */
export const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/agent_board";

export function databaseUrl(): string {
  return (process.env.DATABASE_URL || DEFAULT_DATABASE_URL).trim();
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl() });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  cwd TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id),
  prompt TEXT NOT NULL,
  model TEXT,
  session_id TEXT,
  iteration INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  pid INT,
  summary TEXT,
  output TEXT,
  last_event TEXT,
  error TEXT,
  exit_code INT
);

CREATE TABLE IF NOT EXISTS task_logs (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  line TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_logs_task_id_idx ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS task_logs_task_id_id_idx ON task_logs(task_id, id);

CREATE TABLE IF NOT EXISTS task_outputs (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration INT NOT NULL,
  text TEXT NOT NULL,
  at TIMESTAMPTZ,
  PRIMARY KEY (task_id, iteration)
);

CREATE TABLE IF NOT EXISTS task_prompts (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration INT NOT NULL,
  prompt TEXT NOT NULL,
  at TIMESTAMPTZ,
  PRIMARY KEY (task_id, iteration)
);

CREATE TABLE IF NOT EXISTS task_side_jobs (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  tool_name TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, job_id)
);
`;

export async function ensureSchema(): Promise<void> {
  const p = getPool();
  await p.query(SCHEMA_SQL);
  // Existing DBs created before workspaces: add column if missing
  await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_id TEXT`);
  await p.query(
    `CREATE INDEX IF NOT EXISTS tasks_workspace_id_idx ON tasks(workspace_id)`,
  );
  await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments JSONB`);
}

export function jsonDbExists(): boolean {
  return existsSync(jsonDbPath);
}

export function readJsonDbRaw(): { tasks: unknown[] } | null {
  if (!existsSync(jsonDbPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonDbPath, "utf8")) as { tasks: unknown[] };
  } catch {
    return null;
  }
}

export function listJsonlLogFiles(): { id: string; path: string }[] {
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), path: join(logsDir, f) }));
}

export function archiveJsonDb(): void {
  if (!existsSync(jsonDbPath)) return;
  const dest = `${jsonDbPath}.migrated-${Date.now()}`;
  try {
    renameSync(jsonDbPath, dest);
    console.log(`[db] archived ${jsonDbPath} -> ${dest}`);
  } catch (err) {
    console.warn("[db] could not archive db.json:", err);
  }
}
