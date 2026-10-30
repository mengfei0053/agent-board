import { nanoid } from "nanoid";
import {
  appendLog,
  deleteTasks,
  getDefaultWorkspaceId,
  getTask,
  getWorkspace,
  listTasks,
  listWorkspaces,
  logLineCount,
  readLogTail as storeReadLogTail,
  removeLog,
  clearTaskLogs,
  truncateLogLine,
  upsertTask,
} from "./store.js";
import { publish } from "./bus.js";
import { runners } from "./runners/index.js";
import type { BoardLane, CreateTaskInput, SideJob, Task, TaskStatus, Workspace } from "./types.js";
import { resolveDefaultModel } from "./runners/resolveDefaultModel.js";
import type { RunnerHandle } from "./runners/types.js";
import {
  extractFinalOutput,
  extractOutputsByIteration,
  extractPromptsByIteration,
  extractTextFromEventLine,
  latestOutputText,
  mergeOutputTurns,
  mergePromptTurns,
  summarizeOutput,
  upsertOutputTurn,
  upsertPromptTurn,
} from "./extractOutput.js";
import {
  finalizeRunningSideJobs,
  mergeSideJobs,
  sideJobsFromLogLine,
} from "./sideJobs.js";
import {
  appendAttachmentsToPrompt,
  deleteAttachmentFiles,
  expandUploadUrlsInPrompt,
  stripImageMarkdown,
} from "./uploads.js";

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
  const terminal = cur && ["stopped", "succeeded", "failed", "archived"].includes(cur.status);
  if (!terminal) {
    // Never push multi-MB agent_end dumps over SSE — UI freezes.
    publish({ type: "task_log", taskId: id, line: truncateLogLine(line), at });
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
  const lines = readLogTail(id, 2500, 1_500_000);
  const curIter = cur.iteration ?? 1;
  const extracted = extractOutputsByIteration(lines, curIter);
  // Merge — never replace prior rounds when the log tail lost start/continue markers.
  const outputs = mergeOutputTurns(cur.outputs, extracted, curIter);
  const out = latestOutputText(outputs) || extractFinalOutput(lines) || cur.output || "";
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
  const runnerPrompt = appendAttachmentsToPrompt(
    expandUploadUrlsInPrompt(task.prompt),
    task.attachments,
  );
  const runnerTask: Task = { ...task, prompt: runnerPrompt };
  const handle = runner.start(runnerTask, {
    onStatus: (p) => applyStatus(id, p),
    onLog: (line) => writeLog(id, line),
  });
  handles.set(id, handle);
  if (handle.pid) patch(id, { pid: handle.pid });
  return getTask(id)!;
}

function resolveCreateCwd(input: CreateTaskInput): { workspaceId: string; cwd: string } {
  if (input.workspaceId) {
    const ws = getWorkspace(input.workspaceId);
    if (!ws) throw new Error(`workspace not found: ${input.workspaceId}`);
    return { workspaceId: ws.id, cwd: ws.path };
  }
  const cwd = input.cwd?.trim() || "";
  if (!cwd) throw new Error("workspaceId or cwd required");
  // Prefer matching existing workspace by path; else attach to default
  const match = listWorkspaces().find((w) => w.path === cwd);
  if (match) return { workspaceId: match.id, cwd: match.path };
  return { workspaceId: getDefaultWorkspaceId(), cwd };
}

/** Create a draft — do not spawn. */
export function createDraft(input: CreateTaskInput): Task {
  const id = nanoid(10);
  const { workspaceId, cwd } = resolveCreateCwd(input);
  const plainPrompt = stripImageMarkdown(input.prompt) || input.prompt.trim();
  const title = input.title?.trim() || plainPrompt.slice(0, 48) || `${input.kind} task`;
  const createdAt = now();
  const attachments = input.attachments?.length ? input.attachments : undefined;
  const task: Task = {
    id,
    title,
    kind: input.kind,
    workspaceId,
    cwd,
    prompt: input.prompt,
    model: input.model?.trim() || resolveDefaultModel(input.kind),
    iteration: 1,
    status: "draft",
    createdAt,
    updatedAt: createdAt,
    prompts: [{ iteration: 1, prompt: input.prompt, at: createdAt }],
    attachments,
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
  const continuedAt = now();
  const prompts = upsertPromptTurn(t.prompts, {
    iteration: nextIter,
    prompt: continuePrompt,
    at: continuedAt,
  });

  patch(id, {
    status: "queued",
    iteration: nextIter,
    error: undefined,
    exitCode: undefined,
    endedAt: undefined,
    output: undefined,
    // keep outputs history; new iteration fills in as events arrive
    prompts,
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
  const runnerTask: Task = {
    ...fresh,
    prompt: appendAttachmentsToPrompt(expandUploadUrlsInPrompt(fresh.prompt), fresh.attachments),
  };
  const handle = runner.start(
    runnerTask,
    {
      onStatus: (p) => applyStatus(id, p),
      onLog: (line) => writeLog(id, line),
    },
    { continuePrompt: expandUploadUrlsInPrompt(continuePrompt) },
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
 * * → done: stop if active → stopped; archived → restore prior terminal status
 * * → archived: park as archived (stop if needed)
 */
export function moveTask(id: string, lane: BoardLane): Task {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (!["draft", "todo", "running", "done", "archived"].includes(lane)) {
    throw new Error("lane must be draft|todo|running|done|archived");
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

  if (lane === "archived") {
    if (t.status === "archived") return t;
    const h = handles.get(id);
    if (h || ACTIVE.includes(t.status)) {
      h?.stop();
      handles.delete(id);
    }
    const prior =
      t.status === "succeeded" || t.status === "failed" || t.status === "stopped"
        ? t.status
        : "stopped";
    const archived = patch(id, {
      status: "archived",
      pid: undefined,
      endedAt: t.endedAt || now(),
      summary: t.summary ?? "archived",
      lastEvent: `archive:${prior}`,
    });
    // Archived cards keep prompts + per-round replies; drop raw task_logs to save space.
    clearTaskLogs([id]);
    return archived;
  }

  // done
  if (["succeeded", "failed", "stopped"].includes(t.status)) return t;
  if (t.status === "archived") {
    const m = /^archive:(succeeded|failed|stopped)$/.exec(t.lastEvent || "");
    const restored = (m?.[1] as TaskStatus | undefined) || "stopped";
    return patch(id, {
      status: restored,
      lastEvent: "move_done",
      summary: t.summary ?? "restored from archive",
    });
  }
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

  const attachmentBags = deletable
    .map((id) => getTask(id)?.attachments)
    .filter((a): a is NonNullable<Task["attachments"]> => Boolean(a?.length));
  const deleted = deleteTasks(deletable);
  for (const id of deleted) removeLog(id);
  for (const bag of attachmentBags) deleteAttachmentFiles(bag);
  if (deleted.length) publish({ type: "task_delete", taskIds: deleted });
  return { deleted, stopped, skipped };
}

export function boardSnapshot(workspaceId?: string): Task[] {
  return listTasks(workspaceId);
}

export function workspaceSnapshot(): Workspace[] {
  return listWorkspaces();
}

export function readLogTail(id: string, maxLines = 400, maxTotalChars?: number): string[] {
  return storeReadLogTail(id, maxLines, maxTotalChars);
}

function ensureTaskPrompts(t: Task, extractSource: string[]): PromptTurnPatch | undefined {
  const extracted = extractPromptsByIteration(extractSource, t.prompt);
  const merged = mergePromptTurns(t.prompts, extracted);
  if (!merged.length) return undefined;
  const prev = t.prompts || [];
  const changed =
    prev.length !== merged.length ||
    merged.some((p, i) => prev[i]?.iteration !== p.iteration || prev[i]?.prompt !== p.prompt);
  return changed ? { prompts: merged } : undefined;
}

type PromptTurnPatch = { prompts: NonNullable<Task["prompts"]> };

export function taskWithOutput(id: string): {
  task: Task;
  log: string[];
  logLineCount: number;
} | undefined {
  const t = getTask(id);
  if (!t) return undefined;
  const count = logLineCount(t.id);
  // Keep open-detail payload small: do not embed multi-MB raw logs here.
  // Callers that need logs use taskLogTail() / GET /api/tasks/:id/log.
  const extractSource = readLogTail(t.id, 800, 1_000_000);
  const promptPatch = ensureTaskPrompts(t, extractSource);

  if (t.outputs?.length || t.output) {
    if (!t.outputs?.length && t.output) {
      const extracted = extractOutputsByIteration(extractSource, t.iteration ?? 1);
      const outputs = mergeOutputTurns(t.outputs, extracted, t.iteration ?? 1);
      if (outputs.length) {
        const task = patch(id, {
          outputs,
          output: latestOutputText(outputs) || t.output,
          ...(promptPatch || {}),
        });
        return { task, log: [], logLineCount: count };
      }
    }
    if (promptPatch) {
      const task = patch(id, promptPatch);
      return { task, log: [], logLineCount: count };
    }
    return { task: t, log: [], logLineCount: count };
  }
  const extracted = extractOutputsByIteration(extractSource, t.iteration ?? 1);
  const outputs = mergeOutputTurns(t.outputs, extracted, t.iteration ?? 1);
  const out = latestOutputText(outputs);
  if (!out) {
    if (promptPatch) {
      const task = patch(id, promptPatch);
      return { task, log: [], logLineCount: count };
    }
    return { task: t, log: [], logLineCount: count };
  }
  const summary = t.summary && t.summary !== "agent settled" && t.summary !== "starting"
    ? t.summary
    : summarizeOutput(out);
  const task = patch(id, { output: out, outputs, summary, ...(promptPatch || {}) });
  return { task, log: [], logLineCount: count };
}

/** Capped log tail for the raw-log viewer popup (not the main detail modal). */
export function taskLogTail(id: string, maxLines = 500): {
  log: string[];
  logLineCount: number;
} | undefined {
  if (!getTask(id)) return undefined;
  return {
    log: readLogTail(id, maxLines),
    logLineCount: logLineCount(id),
  };
}

/** Create draft then immediately start (queued → runner). */
export function createAndStart(input: CreateTaskInput): Task {
  const draft = createDraft(input);
  return startTask(draft.id);
}
