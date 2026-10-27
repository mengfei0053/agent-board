import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { getTask, listTasks, logPath, upsertTask } from "./store.js";
import { publish } from "./bus.js";
import { runners } from "./runners/index.js";
import type { CreateTaskInput, Task, TaskStatus } from "./types.js";
import type { RunnerHandle } from "./runners/types.js";

const handles = new Map<string, RunnerHandle>();

function now() {
  return new Date().toISOString();
}

function writeLog(id: string, line: string) {
  const p = logPath(id);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, line.endsWith("\n") ? line : `${line}\n`);
  publish({ type: "task_log", taskId: id, line, at: now() });
}

function patch(id: string, partial: Partial<Task>): Task {
  const cur = getTask(id);
  if (!cur) throw new Error(`task ${id} missing`);
  const next: Task = { ...cur, ...partial, updatedAt: now() };
  upsertTask(next);
  publish({ type: "task_upsert", task: next });
  return next;
}

export function createAndStart(input: CreateTaskInput): Task {
  const id = nanoid(10);
  const title = input.title?.trim() || input.prompt.trim().slice(0, 48) || `${input.kind} task`;
  const task: Task = {
    id,
    title,
    kind: input.kind,
    cwd: input.cwd,
    prompt: input.prompt,
    model: input.model,
    status: "queued",
    createdAt: now(),
    updatedAt: now(),
  };
  upsertTask(task);
  publish({ type: "task_upsert", task });

  const runner = runners[input.kind];
  const handle = runner.start(task, {
    onStatus: (p) => patch(id, p),
    onLog: (line) => writeLog(id, line),
  });
  handles.set(id, handle);
  if (handle.pid) patch(id, { pid: handle.pid });
  return getTask(id)!;
}

export function stopTask(id: string): Task {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  const h = handles.get(id);
  h?.stop();
  handles.delete(id);
  return patch(id, {
    status: "stopped" satisfies TaskStatus,
    endedAt: now(),
    summary: t.summary ?? "stopped by user",
  });
}

export function boardSnapshot() {
  return listTasks();
}

export function readLogTail(id: string, maxLines = 400): string[] {
  const p = logPath(id);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}
