import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { deleteTasks, getTask, listTasks, logPath, removeLog, upsertTask } from "./store.js";
import { publish } from "./bus.js";
import { runners } from "./runners/index.js";
import type { CreateTaskInput, Task, TaskStatus } from "./types.js";
import { resolveDefaultModel } from "./runners/resolveDefaultModel.js";
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

const ACTIVE: TaskStatus[] = ["queued", "running", "blocked"];

export function createAndStart(input: CreateTaskInput): Task {
  const id = nanoid(10);
  const title = input.title?.trim() || input.prompt.trim().slice(0, 48) || `${input.kind} task`;
  const task: Task = {
    id,
    title,
    kind: input.kind,
    cwd: input.cwd,
    prompt: input.prompt,
    model: input.model?.trim() || resolveDefaultModel(input.kind),
    iteration: 1,
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

export function continueTask(id: string, prompt?: string): Task {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (t.status === "queued" || t.status === "running") {
    throw new Error("task is still running; stop it before continue");
  }

  // blocked may still have a live child — stop first so we can resume cleanly
  const existing = handles.get(id);
  if (existing) {
    existing.stop();
    handles.delete(id);
  }

  const continuePrompt = prompt?.trim() || "请基于当前上下文继续完成任务";
  const nextIter = (t.iteration ?? 1) + 1;

  patch(id, {
    status: "queued",
    iteration: nextIter,
    error: undefined,
    exitCode: undefined,
    endedAt: undefined,
    summary: `continuing (iteration ${nextIter})`,
    lastEvent: "continue",
    pid: undefined,
  });

  writeLog(
    id,
    JSON.stringify({
      type: "continue",
      iteration: nextIter,
      prompt: continuePrompt,
      sessionId: t.sessionId,
    }),
  );

  const fresh = getTask(id)!;
  const runner = runners[fresh.kind];
  const handle = runner.start(
    fresh,
    {
      onStatus: (p) => patch(id, p),
      onLog: (line) => writeLog(id, line),
    },
    { continuePrompt },
  );
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

/** Stop live processes if needed, then remove tasks + logs. Returns deleted ids. */
export function removeTasks(ids: string[]): { deleted: string[]; stopped: string[] } {
  const stopped: string[] = [];
  const unique = [...new Set(ids.filter(Boolean))];
  for (const id of unique) {
    const t = getTask(id);
    if (!t) continue;
    const h = handles.get(id);
    if (h || ACTIVE.includes(t.status)) {
      try {
        h?.stop();
      } catch {
        /* ignore */
      }
      handles.delete(id);
      stopped.push(id);
    }
  }
  const deleted = deleteTasks(unique);
  for (const id of deleted) removeLog(id);
  if (deleted.length) publish({ type: "task_delete", taskIds: deleted });
  return { deleted, stopped };
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
