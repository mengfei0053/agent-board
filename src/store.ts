import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = join(root, "data");
export const logsDir = join(dataDir, "logs");
const dbPath = join(dataDir, "db.json");

mkdirSync(logsDir, { recursive: true });

type Db = { tasks: Task[] };

function load(): Db {
  if (!existsSync(dbPath)) return { tasks: [] };
  try {
    return JSON.parse(readFileSync(dbPath, "utf8")) as Db;
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
  return db.tasks.find((t) => t.id === id);
}

export function upsertTask(task: Task): Task {
  const i = db.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) db.tasks[i] = task;
  else db.tasks.unshift(task);
  save(db);
  return task;
}

export function logPath(id: string) {
  return join(logsDir, `${id}.jsonl`);
}
