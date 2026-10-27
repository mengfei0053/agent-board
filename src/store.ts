import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = join(root, "data");
export const logsDir = join(dataDir, "logs");
const dbPath = join(dataDir, "db.json");

mkdirSync(logsDir, { recursive: true });

type Db = { tasks: Task[] };

function normalizeTask(t: Task): Task {
  return {
    ...t,
    iteration: typeof t.iteration === "number" && t.iteration >= 1 ? t.iteration : 1,
  };
}

function load(): Db {
  if (!existsSync(dbPath)) return { tasks: [] };
  try {
    const raw = JSON.parse(readFileSync(dbPath, "utf8")) as Db;
    return { tasks: (raw.tasks || []).map((t) => normalizeTask(t)) };
  } catch {
    return { tasks: [] };
  }
}

function save(db: Db) {
  const tmp = `${dbPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, dbPath);
}

let db = load();

export function listTasks(): Task[] {
  return [...db.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTask(id: string): Task | undefined {
  const t = db.tasks.find((x) => x.id === id);
  return t ? normalizeTask(t) : undefined;
}

export function upsertTask(task: Task): Task {
  const normalized = normalizeTask(task);
  const i = db.tasks.findIndex((t) => t.id === normalized.id);
  if (i >= 0) db.tasks[i] = normalized;
  else db.tasks.unshift(normalized);
  save(db);
  return normalized;
}

export function deleteTasks(ids: string[]): string[] {
  const want = new Set(ids);
  const removed: string[] = [];
  db.tasks = db.tasks.filter((t) => {
    if (!want.has(t.id)) return true;
    removed.push(t.id);
    return false;
  });
  if (removed.length) save(db);
  return removed;
}

export function logPath(id: string) {
  return join(logsDir, `${id}.jsonl`);
}

export function removeLog(id: string) {
  const p = logPath(id);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore */
  }
}
