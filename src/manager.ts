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
  saveTaskDurable,
  setTasksDeletedListener,
  truncateLogLine,
  upsertTask,
} from "./store.js";
import { publish } from "./bus.js";
import { runners } from "./runners/index.js";
import type { BoardLane, CreateTaskInput, SideJob, Task, TaskStatus, Workspace } from "./types.js";
import { resolveDefaultModel } from "./runners/resolveDefaultModel.js";
import { applyWorkspaceToPrompt } from "./workspaceApply.js";
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
  expandUploadUrlsInPrompt,
  removeUploadsIfUnreferenced,
  stripImageMarkdown,
} from "./uploads.js";
import { resolveAllowedDirectory } from "./paths.js";
import { BOARD_FIELD_CHARS } from "./limits.js";

const handles = new Map<string, RunnerHandle>();
/** Serializes start/move/stop/continue for one task across awaits. */
const taskOpTail = new Map<string, Promise<unknown>>();
let draining = false;

export function isDraining(): boolean {
  return draining;
}

export function beginDraining(): void {
  draining = true;
}

function withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskOpTail.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  taskOpTail.set(
    id,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
/** Coalesce rapid output/sideJob patches so stop/SSE stay responsive. */
type PendingPatch = { runId: number; partial: Partial<Task> };
const pendingPatch = new Map<string, PendingPatch>();
const patchTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped on start/continue/stop/move/natural end so a delayed patch cannot cross runs. */
const taskRunIds = new Map<string, number>();

function currentRunId(id: string): number {
  return taskRunIds.get(id) ?? 0;
}

function bumpRun(id: string): number {
  const next = currentRunId(id) + 1;
  taskRunIds.set(id, next);
  return next;
}

/** Take and disarm any deferred output/sideJob patch for this task. */
function takePendingPatch(id: string): PendingPatch | undefined {
  const timer = patchTimers.get(id);
  if (timer) clearTimeout(timer);
  patchTimers.delete(id);
  const partial = pendingPatch.get(id);
  pendingPatch.delete(id);
  return partial;
}

/**
 * Drop a deferred patch without writing. Used when the task is leaving the store
 * so a later timer cannot patch() a missing id or overwrite a reused one.
 */
function cancelPendingPatch(id: string): void {
  takePendingPatch(id);
}

function flushPendingPatch(id: string) {
  const pending = takePendingPatch(id);
  if (!pending || Object.keys(pending.partial).length === 0) return;
  // This runs from a timer, outside the request that deleted the task.
  // Missing ids are a no-op here. patch() itself still throws, so start/stop/move
  // do not swallow a real "task missing" bug.
  if (!getTask(id)) return;
  if (pending.runId !== currentRunId(id)) return;
  patch(id, pending.partial);
}

function schedulePatch(id: string, partial: Partial<Task>, immediate = false) {
  const runId = currentRunId(id);
  const cur = pendingPatch.get(id);
  const base = cur && cur.runId === runId ? cur.partial : {};
  if (cur && cur.runId !== runId) takePendingPatch(id);
  pendingPatch.set(id, { runId, partial: { ...base, ...partial } });
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
      const baseOutputs =
        (pending && pending.runId === currentRunId(id) ? pending.partial.outputs : undefined) ||
        cur.outputs;
      const outputs = upsertOutputTurn(baseOutputs, { iteration: iter, text: piece, at });
      const latest = latestOutputText(outputs);
      patchPartial.output = latest;
      patchPartial.outputs = outputs;
      patchPartial.summary = summarizeOutput(latest);
    }
  }
  try {
    const pendingSides = pendingPatch.get(id);
    const baseSides =
      (pendingSides && pendingSides.runId === currentRunId(id)
        ? (pendingSides.partial.sideJobs as Task["sideJobs"])
        : undefined) || cur.sideJobs;
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

function isTerminalStatus(status: TaskStatus | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped";
}

function applyStatus(id: string, partial: Partial<Task>): Task {
  const cur = getTask(id);
  if (!cur) throw new Error(`task ${id} missing`);
  const merged: Partial<Task> = { ...partial };
  const terminal = isTerminalStatus(merged.status);
  // Commit the deferred output/sideJobs snapshot before settling this run.
  if (terminal) flushPendingPatch(id);
  const fresh = getTask(id) ?? cur;
  // Keep the first real start time across continue / re-runs.
  if (merged.startedAt && fresh.startedAt) {
    merged.startedAt = fresh.startedAt;
  }
  if (terminal && !merged.endedAt) {
    merged.endedAt = now();
  }
  if (terminal) {
    const endedAt = merged.endedAt || now();
    merged.endedAt = endedAt;
    merged.pid = undefined;
    const closed = finalizeRunningSideJobs(
      (merged.sideJobs as SideJob[] | undefined) || fresh.sideJobs,
      endedAt,
      merged.status === "failed" ? "failed" : "stopped",
    );
    if (closed) merged.sideJobs = closed;
  }
  const next = patch(id, merged);
  if (terminal) {
    refreshOutputFromLogs(id);
    handles.delete(id);
    bumpRun(id);
    cancelPendingPatch(id);
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
  const withUploads = appendAttachmentsToPrompt(
    expandUploadUrlsInPrompt(task.prompt),
    task.attachments,
  );
  const wsSettings = getWorkspace(task.workspaceId)?.settings;
  const runnerPrompt = applyWorkspaceToPrompt(wsSettings, withUploads);
  if (runnerPrompt !== withUploads) {
    writeLog(
      id,
      JSON.stringify({
        type: "workspace_settings_applied",
        workspaceId: task.workspaceId,
        note: "prepended workspace systemPrompt/skills/mcp to runner prompt",
      }),
    );
  }
  const runnerTask: Task = { ...task, prompt: runnerPrompt };
  const runId = currentRunId(id);
  const handle = runner.start(runnerTask, {
    onStatus: (p) => {
      if (currentRunId(id) !== runId) return;
      applyStatus(id, p);
    },
    onLog: (line) => {
      if (currentRunId(id) !== runId) return;
      writeLog(id, line);
    },
  });
  if (currentRunId(id) !== runId) {
    try { handle.stop(); } catch { /* ignore */ }
    return getTask(id)!;
  }
  handles.set(id, handle);
  if (handle.pid && currentRunId(id) === runId) patch(id, { pid: handle.pid });
  return getTask(id)!;
}

function resolveCreateCwd(input: CreateTaskInput): { workspaceId: string; cwd: string } {
  if (input.workspaceId) {
    const ws = getWorkspace(input.workspaceId);
    if (!ws) throw new Error(`workspace not found: ${input.workspaceId}`);
    const cwd = resolveAllowedDirectory(ws.path, "cwd");
    return { workspaceId: ws.id, cwd };
  }
  const cwd = input.cwd?.trim() || "";
  if (!cwd) throw new Error("workspaceId or cwd required");
  const resolved = resolveAllowedDirectory(cwd, "cwd");
  // Prefer matching existing workspace by path; else attach to default
  const match = listWorkspaces().find((w) => w.path === resolved || w.path === cwd);
  if (match) return { workspaceId: match.id, cwd: resolveAllowedDirectory(match.path, "cwd") };
  return { workspaceId: getDefaultWorkspaceId(), cwd: resolved };
}

function beginFreshRun(id: string): void {
  flushPendingPatch(id);
  bumpRun(id);
  cancelPendingPatch(id);
}

async function patchDurable(id: string, partial: Partial<Task>): Promise<Task> {
  const cur = getTask(id);
  if (!cur) throw new Error(`task ${id} missing`);
  const next: Task = { ...cur, ...partial, updatedAt: now() };
  await saveTaskDurable(next);
  const stored = getTask(id) ?? next;
  publish({ type: "task_upsert", task: stored });
  return stored;
}

/** Create a draft — do not spawn. */
export async function createDraft(input: CreateTaskInput): Promise<Task> {
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
  await saveTaskDurable(task);
  publish({ type: "task_upsert", task: getTask(id) ?? task });
  writeLog(id, JSON.stringify({ type: "draft_created" }));
  return getTask(id)!;
}

/** Start a draft (or re-queue a terminal task as a fresh run without continue). */
export function startTask(id: string): Promise<Task> {
  return withTaskLock(id, () => startTaskBody(id));
}

async function startTaskBody(id: string): Promise<Task> {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (t.status === "queued" || t.status === "running") {
    throw new Error("task is already running");
  }
  if (t.status === "blocked") {
    throw new Error("task is blocked; stop it before starting again");
  }
  resolveAllowedDirectory(t.cwd, "cwd");

  beginFreshRun(id);
  const existing = handles.get(id);
  if (existing) {
    try {
      existing.stop();
    } catch {
      /* ignore */
    }
    handles.delete(id);
  }

  const startedAt = now();
  const runAtQueue = currentRunId(id);
  clearTaskLogs([id]);
  await patchDurable(id, {
    status: "queued",
    iteration: 1,
    prompts: [{ iteration: 1, prompt: t.prompt, at: startedAt }],
    sessionId: undefined,
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
  const after = getTask(id);
  if (!after || after.status !== "queued" || currentRunId(id) !== runAtQueue) {
    return after ?? t;
  }
  writeLog(id, JSON.stringify({ type: "start", from: t.status }));
  return spawnRunner(getTask(id)!);
}

export function continueTask(id: string, prompt?: string): Promise<Task> {
  return withTaskLock(id, () => continueTaskBody(id, prompt));
}

async function continueTaskBody(id: string, prompt?: string): Promise<Task> {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (t.status === "draft") {
    throw new Error("draft has no session yet; start it first (drag to Todo)");
  }
  if (t.status === "queued" || t.status === "running") {
    throw new Error("task is still running; stop it before continue");
  }
  resolveAllowedDirectory(t.cwd, "cwd");

  beginFreshRun(id);
  const existing = handles.get(id);
  if (existing) {
    try {
      existing.stop();
    } catch {
      /* ignore */
    }
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

  const runAtQueue = currentRunId(id);
  await patchDurable(id, {
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
  const after = getTask(id);
  if (!after || after.status !== "queued" || currentRunId(id) !== runAtQueue) {
    return after ?? t;
  }

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
  const runId = currentRunId(id);
  const runner = runners[fresh.kind];
  const basePrompt = appendAttachmentsToPrompt(
    expandUploadUrlsInPrompt(fresh.prompt),
    fresh.attachments,
  );
  const hasSession = Boolean(fresh.sessionId);
  // Re-apply workspace prefix only when continuing without a session (fresh run).
  const wsSettings = getWorkspace(fresh.workspaceId)?.settings;
  const runnerPrompt = applyWorkspaceToPrompt(wsSettings, basePrompt, {
    continueWithSession: hasSession,
  });
  const contPrompt = expandUploadUrlsInPrompt(continuePrompt);
  const runnerTask: Task = {
    ...fresh,
    prompt: runnerPrompt,
  };
  const handle = runner.start(
    runnerTask,
    {
      onStatus: (p) => {
        if (currentRunId(id) !== runId) return;
        applyStatus(id, p);
      },
      onLog: (line) => {
        if (currentRunId(id) !== runId) return;
        writeLog(id, line);
      },
    },
    { continuePrompt: contPrompt },
  );
  if (currentRunId(id) !== runId) {
    try { handle.stop(); } catch { /* ignore */ }
    return getTask(id)!;
  }
  handles.set(id, handle);
  if (handle.pid && currentRunId(id) === runId) patch(id, { pid: handle.pid });
  return getTask(id)!;
}

export function stopTask(id: string): Promise<Task> {
  return withTaskLock(id, () => stopTaskBody(id));
}

async function stopTaskBody(id: string): Promise<Task> {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  // Flush first, then read sideJobs so a just-merged job is not dropped.
  flushPendingPatch(id);
  const fresh = getTask(id) ?? t;
  // Invalidate runner callbacks and stop the process before the durable
  // write, so a slow commit cannot observe a new running status or a new run.
  bumpRun(id);
  cancelPendingPatch(id);
  const h = handles.get(id);
  handles.delete(id);
  try {
    h?.stop();
  } catch (err) {
    console.warn("[stop] kill failed", id, err);
  }
  const endedAt = now();
  const sideJobs = finalizeRunningSideJobs(fresh.sideJobs, endedAt, "stopped") ?? fresh.sideJobs;
  try {
    const updated = await patchDurable(id, {
      status: "stopped" satisfies TaskStatus,
      endedAt,
      summary: fresh.summary ?? "stopped by user",
      sideJobs,
      pid: undefined,
    });
    return getTask(id) ?? updated;
  } catch (err) {
    const cur = getTask(id);
    if (cur && (cur.status === "queued" || cur.status === "running" || cur.status === "blocked")) {
      upsertTask({
        ...cur,
        status: "failed",
        error: "进程已停止，但状态写入失败",
        endedAt,
        pid: undefined,
        updatedAt: now(),
      });
    }
    throw err;
  }
}

/**
 * Move a card to a board lane.
 * draft → todo|running: start runner
 * * → draft: park as draft (stop if needed)
 * * → done: stop if active → stopped; archived → restore prior terminal status
 * * → archived: park as archived (stop if needed)
 */
export function moveTask(id: string, lane: BoardLane): Promise<Task> {
  return withTaskLock(id, () => moveTaskBody(id, lane));
}

async function moveTaskBody(id: string, lane: BoardLane): Promise<Task> {
  const t = getTask(id);
  if (!t) throw new Error("not found");
  if (!["draft", "todo", "running", "done", "archived"].includes(lane)) {
    throw new Error("lane must be draft|todo|running|done|archived");
  }

  if (lane === "todo" || lane === "running") {
    if (t.status === "queued" || t.status === "running" || t.status === "blocked") {
      return t; // already in-flight
    }
    return startTaskBody(id);
  }

  if (lane === "draft") {
    if (t.status === "draft") return t;
    flushPendingPatch(id);
    bumpRun(id);
    cancelPendingPatch(id);
    const h = handles.get(id);
    handles.delete(id);
    if (h || ACTIVE.includes(t.status)) {
      try {
        h?.stop();
      } catch {
        /* ignore */
      }
    }
    return patchDurable(id, {
      status: "draft",
      pid: undefined,
      endedAt: undefined,
      summary: "moved to draft",
      lastEvent: "move_draft",
    });
  }

  if (lane === "archived") {
    if (t.status === "archived") return t;
    flushPendingPatch(id);
    bumpRun(id);
    cancelPendingPatch(id);
    const h = handles.get(id);
    handles.delete(id);
    if (h || ACTIVE.includes(t.status)) {
      try {
        h?.stop();
      } catch {
        /* ignore */
      }
    }
    const prior =
      t.status === "succeeded" || t.status === "failed" || t.status === "stopped"
        ? t.status
        : "stopped";
    const archived = await patchDurable(id, {
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
    return patchDurable(id, {
      status: restored,
      lastEvent: "move_done",
      summary: t.summary ?? "restored from archive",
    });
  }
  if (t.status === "draft") {
    return patchDurable(id, {
      status: "stopped",
      endedAt: now(),
      summary: "moved to done without running",
      lastEvent: "move_done",
    });
  }
  return stopTaskBody(id);
}

type RemoveTasksResult = {
  deleted: string[];
  stopped: string[];
  skipped: { id: string; status: TaskStatus; reason: string }[];
};

/** Stop live processes if needed, then remove tasks + logs. Skips queued/running. */
export async function removeTasks(ids: string[]): Promise<RemoveTasksResult> {
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

  // After stop(), which may have logged and armed a new timer. Discard — do not
  // flush — because the row is about to disappear. deleteTasks repeats this for
  // any other caller that removes rows from the store.
  for (const id of deletable) cancelPendingPatch(id);

  const attachmentNames = deletable.flatMap((id) => getTask(id)?.attachments?.map((a) => a.name) || []);
  const deleted = await deleteTasks(deletable);
  for (const id of deleted) removeLog(id);
  if (attachmentNames.length) {
    try {
      await removeUploadsIfUnreferenced(attachmentNames, listTasks());
    } catch (err) {
      console.warn("[uploads] unreferenced cleanup failed:", err);
    }
  }
  if (deleted.length) publish({ type: "task_delete", taskIds: deleted });
  return { deleted, stopped, skipped };
}

function clipBoardText(s: string | undefined): string | undefined {
  if (!s || s.length <= BOARD_FIELD_CHARS) return s;
  return `${s.slice(0, BOARD_FIELD_CHARS)}…`;
}

/** List/hello payload: keep card fields, clip long prompt/output bodies. */
export type BoardTaskSummary = Task & {
  /** List/SSE payload. Must not replace an open detail's full text. */
  boardSummary: true;
  outputTruncated?: boolean;
  promptTruncated?: boolean;
};

export function presentBoardTask(t: Task): BoardTaskSummary {
  const outputTruncated = Boolean(t.output && t.output.length > BOARD_FIELD_CHARS)
    || Boolean(t.outputs?.some((o) => o.text.length > BOARD_FIELD_CHARS));
  const promptTruncated = Boolean(t.prompt && t.prompt.length > BOARD_FIELD_CHARS)
    || Boolean(t.prompts?.some((p) => p.prompt.length > BOARD_FIELD_CHARS));
  return {
    ...t,
    prompt: clipBoardText(t.prompt) || t.prompt,
    output: clipBoardText(t.output),
    outputs: t.outputs?.map((o) => ({ ...o, text: clipBoardText(o.text) || "" })),
    prompts: t.prompts?.map((p) => ({ ...p, prompt: clipBoardText(p.prompt) || "" })),
    boardSummary: true,
    ...(outputTruncated ? { outputTruncated: true } : {}),
    ...(promptTruncated ? { promptTruncated: true } : {}),
  };
}

export function boardSnapshot(workspaceId?: string): Task[] {
  return listTasks(workspaceId).map(presentBoardTask);
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
export async function createAndStart(input: CreateTaskInput): Promise<Task> {
  const draft = await createDraft(input);
  return startTask(draft.id);
}

/** Stop runners and flush deferred patches. Used by process shutdown. */
export async function shutdownManager(deadlineMs = 4_000): Promise<void> {
  beginDraining();
  const waits: Promise<void>[] = [];
  for (const id of [...handles.keys()]) {
    const h = handles.get(id);
    handles.delete(id);
    if (h?.stopAndWait) {
      waits.push(h.stopAndWait(deadlineMs).catch(() => undefined));
    } else {
      try {
        h?.stop();
      } catch {
        /* ignore */
      }
    }
  }
  await Promise.race([
    Promise.all(waits),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, deadlineMs);
      timer.unref?.();
    }),
  ]);
  for (const id of [...patchTimers.keys()]) flushPendingPatch(id);
  pendingPatch.clear();
}


/** True when a deferred output/sideJob patch is still queued for this task. */
export function hasPendingPatchForTests(id: string): boolean {
  return patchTimers.has(id) || pendingPatch.has(id);
}

/** Integration tests: drop live runner handles and pending patches. */
export function clearHandlesForTests(): void {
  for (const id of [...handles.keys()]) {
    const h = handles.get(id);
    handles.delete(id);
    try {
      h?.stop();
    } catch {
      /* ignore */
    }
  }
  for (const id of [...patchTimers.keys()]) {
    flushPendingPatch(id);
  }
  pendingPatch.clear();
  taskRunIds.clear();
  taskOpTail.clear();
  draining = false;
}

setTasksDeletedListener((ids) => {
  for (const id of ids) {
    cancelPendingPatch(id);
    taskRunIds.delete(id);
  }
});
