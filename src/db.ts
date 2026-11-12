import pg from "pg";
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SqlitePool, type DatabasePool } from "./databaseAdapter.js";

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

/** SQLite defaults stay under DATA_DIR, including isolated test roots. */
export const DEFAULT_DATABASE_URL = `sqlite:${join(repoDataDir(), "agent-board.db")}`;

export function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || `sqlite:${join(dataDir(), "agent-board.db")}`;
}

export function databaseKind(url = databaseUrl()): "postgres" | "sqlite" {
  if (/^postgres(?:ql)?:\/\//.test(url)) return "postgres";
  if (url.startsWith("sqlite:")) return "sqlite";
  throw new Error("DATABASE_URL must use postgres://, postgresql://, or sqlite:");
}

export function sqliteFilename(url = databaseUrl()): string {
  if (!url.startsWith("sqlite:")) throw new Error("Expected a sqlite: database URL");
  const filename = url.slice("sqlite:".length);
  if (filename === ":memory:") return filename;
  if (!filename || filename.startsWith("//") || /[?#\0]/.test(filename)) {
    throw new Error("Use sqlite:./file.db, sqlite:/absolute/file.db, or sqlite::memory:");
  }
  return resolve(filename);
}

/** Array values are encoded as JSON only on SQLite; PostgreSQL keeps typed arrays. */
export function arrayParameter(values: readonly unknown[]): string | readonly unknown[] {
  return databaseKind() === "sqlite" ? JSON.stringify(values) : values;
}

export function arrayPredicate(column: string, parameter: number, type = "text"): string {
  return databaseKind() === "sqlite"
    ? `${column} IN (SELECT value FROM json_each($${parameter}))`
    : `${column} = ANY($${parameter}::${type}[])`;
}

export function regexPredicate(column: string, parameter: number): string {
  return `${column} ${databaseKind() === "sqlite" ? "REGEXP" : "~"} $${parameter}`;
}

export function latestTimestamp(left: string, right: string): string {
  return `${databaseKind() === "sqlite" ? "MAX" : "GREATEST"}(${left}, ${right})`;
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

let pool: DatabasePool | null = null;

export function hasPool(): boolean {
  return pool !== null;
}

export function getPool(): DatabasePool {
  if (!pool) {
    const url = databaseUrl();
    if (databaseKind(url) === "sqlite") {
      const filename = sqliteFilename(url);
      if (filename !== ":memory:") {
        assertDataRootAllowed(filename);
        mkdirSync(dirname(filename), { recursive: true });
      }
      pool = new SqlitePool(filename);
    } else {
      // SAFETY: pg supplies the same async query/connect/end contract; our rows omit pg-only metadata.
      pool = new Pool({ connectionString: url }) as unknown as DatabasePool;
    }
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

CREATE TABLE IF NOT EXISTS model_history (
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (kind, model)
);
CREATE INDEX IF NOT EXISTS model_history_recent_idx ON model_history(kind, last_used_at DESC);

CREATE TABLE IF NOT EXISTS agent_models (
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_efforts JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, model)
);
CREATE INDEX IF NOT EXISTS agent_models_kind_idx ON agent_models(kind, model);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  sort_order INT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  cwd TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id),
  prompt TEXT NOT NULL,
  model TEXT,
  thinking_effort TEXT,
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
  exit_code INT,
  worktree JSONB
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
  const sqlite = databaseKind() === "sqlite";
  const schema = sqlite
    ? SCHEMA_SQL.replace(/BIGSERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
      .replace(/TIMESTAMPTZ|JSONB/g, "TEXT")
      .replace(/'\[\]'::jsonb/g, "'[]'")
      .replace(/NOW\(\)/g, "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
    : SCHEMA_SQL;
  // SQLite prepares one statement at a time. This schema is static DDL only.
  for (const statement of schema.split(";").filter((sql) => sql.trim())) await p.query(statement);
  for (const [table, column, type] of [
    ["tasks", "workspace_id", "TEXT"], ["tasks", "attachments", "JSONB"],
    ["tasks", "worktree", "JSONB"], ["tasks", "thinking_effort", "TEXT"],
    ["workspaces", "settings", "JSONB"], ["workspaces", "sort_order", "INT"],
  ]) {
    if (sqlite) {
      const { rows } = await p.query<{ name: string }>(`PRAGMA table_info(${table})`);
      if (rows.some((row) => row.name === column)) continue;
    }
    await p.query(`ALTER TABLE ${table} ADD COLUMN ${sqlite ? "" : "IF NOT EXISTS "}${column} ${sqlite && type === "JSONB" ? "TEXT" : type}`);
  }
  await p.query(`CREATE INDEX IF NOT EXISTS tasks_workspace_id_idx ON tasks(workspace_id)`);
  // Recover models used before model history was introduced.
  await p.query(`
    INSERT INTO model_history (kind, model, last_used_at)
    SELECT kind, TRIM(model), MAX(created_at) FROM tasks
    WHERE model IS NOT NULL AND TRIM(model) <> ''
    GROUP BY kind, TRIM(model)
    ON CONFLICT (kind, model) DO UPDATE SET
      last_used_at = ${latestTimestamp("model_history.last_used_at", "EXCLUDED.last_used_at")}
  `);
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
