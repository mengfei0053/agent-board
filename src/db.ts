import pg from "pg";
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo `data/` directory. Tests must not use this; set DATA_DIR instead. */
export function repoDataDir(): string {
  return join(repoRoot, "data");
}

/**
 * Data root. `DATA_DIR` overrides the repo `data/` folder so tests and a
 * second instance can keep uploads, logs, and db.json off the real tree.
 */
export function dataDir(): string {
  const raw = process.env.DATA_DIR?.trim();
  return raw ? resolve(raw) : repoDataDir();
}

export function logsDir(): string {
  return join(dataDir(), "logs");
}

export function jsonDbPath(): string {
  return join(dataDir(), "db.json");
}

export function isRepoDataPath(target: string): boolean {
  const root = resolve(repoDataDir());
  const abs = resolve(target);
  return abs === root || abs.startsWith(root + sep);
}

/** True when this process must not read or delete the repo data tree. */
export function refuseRepoData(): boolean {
  return process.env.AGENT_BOARD_REFUSE_REPO_DATA === "1";
}

export function assertDataRootAllowed(target: string): void {
  if (refuseRepoData() && isRepoDataPath(target)) {
    throw new Error(`refusing to touch repo data directory: ${target}`);
  }
}

export function ensureDataDirs(): void {
  const logs = logsDir();
  assertDataRootAllowed(logs);
  mkdirSync(logs, { recursive: true });
}

/**
 * Local-dev fallback only. Compose does not use this password; set
 * POSTGRES_PASSWORD and DATABASE_URL explicitly. Not a production default.
 */
export const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/agent_board";

export function databaseUrl(): string {
  return (process.env.DATABASE_URL || DEFAULT_DATABASE_URL).trim();
}

/** Hide password in DATABASE_URL for logs. */
export function redactDatabaseUrl(url?: string): string {
  try {
    const u = new URL((url ?? databaseUrl()).trim());
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(DATABASE_URL)";
  }
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

CREATE TABLE IF NOT EXISTS uploads (
  name TEXT PRIMARY KEY,
  original_name TEXT,
  mime TEXT,
  size INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

/** One transaction for several meta keys. Memory is updated by the caller after this resolves. */
export async function upsertMetaMany(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
  if (!entries.length) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value],
      );
    }
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
}

export async function ensureSchema(): Promise<void> {
  const p = getPool();
  await p.query(SCHEMA_SQL);
  // Existing DBs created before workspaces: add column if missing
  await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_id TEXT`);
  await p.query(
    `CREATE INDEX IF NOT EXISTS tasks_workspace_id_idx ON tasks(workspace_id)`,
  );
  await p.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments JSONB`);
  await p.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS settings JSONB`);
}

export function jsonDbExists(): boolean {
  return existsSync(jsonDbPath());
}

export function readJsonDbRaw(): { tasks: unknown[] } | null {
  const path = jsonDbPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { tasks: unknown[] };
  } catch {
    return null;
  }
}

export function listJsonlLogFiles(): { id: string; path: string }[] {
  const dir = logsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), path: join(dir, f) }));
}

export function archiveJsonDb(): void {
  const path = jsonDbPath();
  if (!existsSync(path)) return;
  const dest = `${path}.migrated-${Date.now()}`;
  try {
    renameSync(path, dest);
    console.log(`[db] archived ${path} -> ${dest}`);
  } catch (err) {
    console.warn("[db] could not archive db.json:", err);
  }
}
