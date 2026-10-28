import { nanoid } from "nanoid";
import {
  appendLog,
  deleteTasks,
  getTask,
  listTasks,
  readLogTail as storeReadLogTail,
  removeLog,
  upsertTask,
} from "./store.js";
import { publish } from "./bus.js";
import { runners } from "./runners/index.js";
import type { BoardLane, CreateTaskInput, SideJob, Task, TaskStatus } from "./types.js";
import { resolveDefaultModel } from "./runners/resolveDefaultModel.js";
import type { RunnerHandle } from "./runners/types.js";
import {
  extractFinalOutput,
  extractOutputsByIteration,
  extractTextFromEventLine,
  latestOutputText,
  summarizeOutput,
  upsertOutputTurn,
} from "./extractOutput.js";
import {
  finalizeRunningSideJobs,
  mergeSideJobs,
  sideJobsFromLogLine,
} from "./sideJobs.js";

const handles = new Map<string, RunnerHandle>();
/** Coalesce rapid output/sideJob patches so stop/SSE stay responsive. */
const pendingPatch = new Map<string, Partial<Task>>();
const patchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushPendingPatch(id: string) {
  const timer = patchTimers.get(id);
  if (timer) clearTimeout(timer);
  patchTimers.delete(id);
  const partial = pendingPatch.get(id);
  pendingPatch.delete(id);
  if (partial && Object.keys(partial).length) patch(id, partial);
}

function schedulePatch(id: string, partial: Partial<Task>, immediate = false) {
  const cur = pendingPatch.get(id) || {};
  pendingPatch.set(id, { ...cur, ...partial });
  if (immediate) {
    flushPendingPatch(id);
    return;
  }
  if (patchTimers.has(id)) return;
  patchTimers.set(
    id,
    setTimeout(() => flushPendingPatch(id), 200),
  );
}


function now() {
  return new Date().toISOString();
}

function writeLog(id: string, line: string) {
  appendLog(id, line);
  const at = now();
  const cur = getTask(id);
  // After terminal status, keep logs in DB but do not flood SSE/UI with upserts.
  const terminal = cur && ["stopped", "succeeded", "failed"].includes(cur.status);
  if (!terminal) {
    publish({ type: "task_log", taskId: id, line, at });
  }
  if (!cur || terminal) return;

  const patchPartial: Partial<Task> = {};
  const piece = extractTextFromEventLine(line);
  if (piece) {
    const iter = cur.iteration ?? 1;
    const prevTurn = cur.outputs?.find((o) => o.iteration === iter);
    if (!prevTurn || prevTurn.text !== piece) {
      const pending = pendingPatch.get(id);
      const baseOutputs = (pending?.outputs as Task["outputs"]) || cur.outputs;
      const outputs = upsertOutputTurn(baseOutputs, { iteration: iter, text: piece, at });
      const latest = latestOutputText(outputs);
      patchPartial.output = latest;
      patchPartial.outputs = outputs;
      patchPartial.summary = summarizeOutput(latest);
    }
  }
  try {
    const baseSides =
      ((pendingPatch.get(id)?.sideJobs as Task["sideJobs"]) || cur.sideJobs);
    const updates = sideJobsFromLogLine(line, at);
    const merged = mergeSideJobs(baseSides, updates);
    if (merged) patchPartial.sideJobs = merged;
  } catch {
    /* never break the log stream on parse errors */
  }
  if (Object.keys(patchPartial).length) schedulePatch(id, patchPartial);
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
  const cur = getTask(id);
  const merged: Partial<Task> = { ...partial };
  // Keep the first real start time across continue / re-runs.
  if (merged.startedAt && cur?.startedAt) {
    merged.startedAt = cur.startedAt;
  }
  if (
    (merged.status === "succeeded" ||
      merged.status === "failed" ||
      merged.status === "stopped") &&
    !merged.endedAt
  ) {
    merged.endedAt = now();
  }
  if (
    merged.status === "succeeded" ||
    merged.status === "failed" ||
    merged.status === "stopped"
  ) {
    const endedAt = merged.endedAt || now();
    merged.endedAt = endedAt;
    const closed = finalizeRunningSideJobs(
      (merged.sideJobs as SideJob[] | undefined) || cur?.sideJobs,
      endedAt,
      merged.status === "failed" ? "failed" : "stopped",
    );
    if (closed) merged.sideJobs = closed;
  }
  const next = patch(id, merged);
  if (
    merged.status === "succeeded" ||
    merged.status === "failed" ||
    merged.status === "stopped"
  ) {
    refreshOutputFromLogs(id);
  }
  return getTask(id) ?? next;
}

export function refreshOutputFromLogs(id: string): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const lines = readLogTail(id, 2500);
  const outputs = extractOutputsByIteration(lines);
  // Preserve wall-clock `at` from prior turns when text unchanged
  if (cur.outputs?.length) {
    const prevByIter = new Map(cur.outputs.map((o) => [o.iteration, o]));
    for (let i = 0; i < outputs.length; i++) {
      const prev = prevByIter.get(outputs[i].iteration);
      if (prev?.at && prev.text === outputs[i].text) {
        outputs[i] = { ...outputs[i], at: prev.at };
      } else if (prev?.at && !outputs[i].at) {
        outputs[i] = { ...outputs[i], at: prev.at };
      }
    }
  }
  const out = latestOutputText(outputs) || extractFinalOutput(lines);
  if (!out && !outputs.length) return cur;
  return patch(id, {
    output: out || undefined,
    outputs,
    summary: out ? summarizeOutput(out) : cur.summary,
  });
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
    outputs: [],
    summary: "starting",
    lastEvent: "start",
    pid: undefined,
    sideJobs: [],
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
    // keep outputs history; new iteration fills in as events arrive
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
  // Mark stopped first so writeLog stops upsert/SSE flood, then cut the child.
  flushPendingPatch(id);
  const endedAt = now();
  const sideJobs = finalizeRunningSideJobs(t.sideJobs, endedAt, "stopped") ?? t.sideJobs;
  const updated = patch(id, {
    status: "stopped" satisfies TaskStatus,
    endedAt,
    summary: t.summary ?? "stopped by user",
    sideJobs,
    pid: undefined,
  });
  const h = handles.get(id);
  handles.delete(id);
  try {
    h?.stop();
  } catch (err) {
    console.warn("[stop] kill failed", id, err);
  }
  return updated;
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
  return storeReadLogTail(id, maxLines);
}

export function taskWithOutput(id: string): { task: Task; log: string[] } | undefined {
  const t = getTask(id);
  if (!t) return undefined;
  const log = readLogTail(t.id, 2500);
  if (t.outputs?.length || t.output) {
    // Backfill outputs from logs if only legacy `output` exists
    if (!t.outputs?.length && t.output) {
      const outputs = extractOutputsByIteration(log);
      if (outputs.length) {
        const task = patch(id, {
          outputs,
          output: latestOutputText(outputs) || t.output,
        });
        return { task, log };
      }
    }
    return { task: t, log };
  }
  const outputs = extractOutputsByIteration(log);
  const out = latestOutputText(outputs);
  if (!out) return { task: t, log };
  const summary = t.summary && t.summary !== "agent settled" && t.summary !== "starting"
    ? t.summary
    : summarizeOutput(out);
  const task = patch(id, { output: out, outputs, summary });
  return { task, log };
}

/** Create draft then immediately start (queued → runner). */
export function createAndStart(input: CreateTaskInput): Task {
  const draft = createDraft(input);
  return startTask(draft.id);
}
