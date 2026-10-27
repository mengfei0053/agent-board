import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { deleteTasks, getTask, listTasks, logPath, removeLog, upsertTask } from "./store.js";
import { publish } from "./bus.js";
import { runners } from "./runners/index.js";
import type { BoardLane, CreateTaskInput, Task, TaskStatus } from "./types.js";
import { resolveDefaultModel } from "./runners/resolveDefaultModel.js";
import type { RunnerHandle } from "./runners/types.js";
import {
  extractFinalOutput,
  extractTextFromEventLine,
  summarizeOutput,
} from "./extractOutput.js";

const handles = new Map<string, RunnerHandle>();

function now() {
  return new Date().toISOString();
}

function writeLog(id: string, line: string) {
  const p = logPath(id);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, line.endsWith("\n") ? line : `${line}\n`);
  publish({ type: "task_log", taskId: id, line, at: now() });
  const piece = extractTextFromEventLine(line);
  if (piece) {
    const cur = getTask(id);
    if (cur && cur.output !== piece) {
      patch(id, { output: piece, summary: summarizeOutput(piece) });
    }
  }
}

function patch(id: string, partial: Partial<Task>): Task {
  const cur = getTask(id);
  if (!cur) throw new Error(`task ${id} missing`);
  const next: Task = { ...cur, ...partial, updatedAt: now() };
  upsertTask(next);
  publish({ type: "task_upsert", task: next });
  return next;
}

function applyStatus(id: string, partial: Partial<Task>): Task {
  const next = patch(id, partial);
  if (
    partial.status === "succeeded" ||
    partial.status === "failed" ||
    partial.status === "stopped"
  ) {
    refreshOutputFromLogs(id);
  }
  return getTask(id) ?? next;
}

export function refreshOutputFromLogs(id: string): Task | undefined {
  const lines = readLogTail(id, 2500);
  const out = extractFinalOutput(lines);
  if (!out) return getTask(id);
  return patch(id, { output: out, summary: summarizeOutput(out) });
}

/** Statuses that still own a live/soon-live runner (cannot delete). */
const UNDELETABLE: TaskStatus[] = ["queued", "running"];
const ACTIVE: TaskStatus[] = ["queued", "running", "blocked"];

export function isUndeletableStatus(status: TaskStatus): boolean {
  return UNDELETABLE.includes(status);
}

function spawnRunner(task: Task): Task {
  const id = task.id;
  const runner = runners[task.kind];
  const handle = runner.start(task, {
    onStatus: (p) => applyStatus(id, p),
    onLog: (line) => writeLog(id, line),
  });
  handles.set(id, handle);
  if (handle.pid) patch(id, { pid: handle.pid });
  return getTask(id)!;
}

/** Create a draft — do not spawn. */
export function createDraft(input: CreateTaskInput): Task {
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
    status: "draft",
    createdAt: now(),
    updatedAt: now(),
  };
  upsertTask(task);
  publish({ type: "task_upsert", task });
  writeLog(id, JSON.stringify({ type: "draft_created" }));
  return getTask(id)!;
}

/** Start a draft (or re-queue a terminal task as a fresh run without continue). */
export function startTask(id: string): Task {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (t.status === "queued" || t.status === "running") {
    throw new Error("task is already running");
  }
  if (t.status === "blocked") {
    throw new Error("task is blocked; stop it before starting again");
  }

  const existing = handles.get(id);
  if (existing) {
    existing.stop();
    handles.delete(id);
  }

  patch(id, {
    status: "queued",
    error: undefined,
    exitCode: undefined,
    endedAt: undefined,
    output: undefined,
    summary: "starting",
    lastEvent: "start",
    pid: undefined,
  });
  writeLog(id, JSON.stringify({ type: "start", from: t.status }));
  return spawnRunner(getTask(id)!);
}

export function continueTask(id: string, prompt?: string): Task {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (t.status === "draft") {
    throw new Error("draft has no session yet; start it first (drag to Todo)");
  }
  if (t.status === "queued" || t.status === "running") {
    throw new Error("task is still running; stop it before continue");
  }

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
    output: undefined,
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
      onStatus: (p) => applyStatus(id, p),
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

/**
 * Move a card to a board lane.
 * draft → todo|running: start runner
 * * → draft: park as draft (stop if needed)
 * * → done: stop if active → stopped
 */
export function moveTask(id: string, lane: BoardLane): Task {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (!["draft", "todo", "running", "done"].includes(lane)) {
    throw new Error("lane must be draft|todo|running|done");
  }

  if (lane === "todo" || lane === "running") {
    if (t.status === "queued" || t.status === "running" || t.status === "blocked") {
      return t; // already in-flight
    }
    return startTask(id);
  }

  if (lane === "draft") {
    if (t.status === "draft") return t;
    const h = handles.get(id);
    if (h || ACTIVE.includes(t.status)) {
      h?.stop();
      handles.delete(id);
    }
    return patch(id, {
      status: "draft",
      pid: undefined,
      endedAt: undefined,
      summary: "moved to draft",
      lastEvent: "move_draft",
    });
  }

  // done
  if (["succeeded", "failed", "stopped"].includes(t.status)) return t;
  if (t.status === "draft") {
    return patch(id, {
      status: "stopped",
      endedAt: now(),
      summary: "moved to done without running",
      lastEvent: "move_done",
    });
  }
  return stopTask(id);
}

/** Stop live processes if needed, then remove tasks + logs. Skips queued/running. */
export function removeTasks(ids: string[]): {
  deleted: string[];
  stopped: string[];
  skipped: { id: string; status: TaskStatus; reason: string }[];
} {
  const stopped: string[] = [];
  const skipped: { id: string; status: TaskStatus; reason: string }[] = [];
  const deletable: string[] = [];
  const unique = [...new Set(ids.filter(Boolean))];

  for (const id of unique) {
    const t = getTask(id);
    if (!t) continue;
    if (isUndeletableStatus(t.status)) {
      skipped.push({
        id,
        status: t.status,
        reason: "Todo/进行中的任务不可删除，请先停止或等其结束",
      });
      continue;
    }
    const h = handles.get(id);
    if (h || t.status === "blocked") {
      try {
        h?.stop();
      } catch {
        /* ignore */
      }
      handles.delete(id);
      stopped.push(id);
    }
    deletable.push(id);
  }

  const deleted = deleteTasks(deletable);
  for (const id of deleted) removeLog(id);
  if (deleted.length) publish({ type: "task_delete", taskIds: deleted });
  return { deleted, stopped, skipped };
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

export function taskWithOutput(id: string): { task: Task; log: string[] } | undefined {
  const t = getTask(id);
  if (!t) return undefined;
  const log = readLogTail(t.id, 2500);
  if (t.output) return { task: t, log };
  const out = extractFinalOutput(log);
  if (!out) return { task: t, log };
  const summary = t.summary && t.summary !== "agent settled" && t.summary !== "starting"
    ? t.summary
    : summarizeOutput(out);
  const task = patch(id, { output: out, summary });
  return { task, log };
}

/** @deprecated alias kept for clarity in older call sites */
export const createAndStart = createDraft;
