import type { AgentKind, OutputTurn, PromptTurn, SideJob, Task } from "../types.js";
import { resumeCommand } from "./resumeCommand.js";

const AGENTS: readonly AgentKind[] = ["pi", "claude", "cursor", "devin", "codex"];

export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped"]);

export type RelayStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "stopped" | "archived";

/** Same alphabet as board workspace ids (`nanoid`) plus the board-id punctuation. */
export const WORKSPACE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

/** Per-turn text on a full `evt.task` / `cmd.detail`. Snapshots use the previews. */
export const DETAIL_TEXT = 2_000;
export const PREVIEW_TEXT = 240;
const MAX_TURNS = 12;
const MAX_SIDE_JOBS = 20;

export type RelayTurn = {
  iteration: number;
  prompt?: string;
  output?: string;
  at?: number;
};

export type RelaySideJob = {
  id: string;
  kind: string;
  title: string;
  status: string;
  summary?: string;
  toolName?: string;
};

/**
 * Phone-facing task. `updatedAt` is epoch milliseconds.
 * Archived tasks are omitted unless `allowArchived` is set for a read-only page or detail.
 */
export type MappedTask = {
  id: string;
  title: string;
  status: RelayStatus;
  updatedAt: number;
  agent?: string;
  summary?: string;
  /** Omitted when the board task has no usable workspace id. */
  workspaceId?: string;
  iteration?: number;
  cwd?: string;
  model?: string;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  pid?: number;
  error?: string;
  prompt?: string;
  output?: string;
  resumeCommand?: string;
  worktreeBranch?: string;
  promptTruncated?: boolean;
  outputTruncated?: boolean;
  turns?: RelayTurn[];
  sideJobs?: RelaySideJob[];
};

type DetailTask = Pick<
  Task,
  | "id"
  | "title"
  | "kind"
  | "status"
  | "updatedAt"
  | "summary"
  | "cwd"
  | "prompt"
  | "model"
  | "sessionId"
  | "iteration"
  | "startedAt"
  | "endedAt"
  | "pid"
  | "output"
  | "outputs"
  | "prompts"
  | "error"
  | "exitCode"
  | "sideJobs"
  | "worktree"
> & {
  workspaceId?: string;
  outputTruncated?: boolean;
  promptTruncated?: boolean;
};

export function mapStatus(status: string, allowArchived = false): RelayStatus | null {
  if (status === "archived") return allowArchived ? "archived" : null;
  if (status === "draft" || status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "blocked") return "paused";
  if (status === "succeeded" || status === "failed" || status === "stopped") return status;
  return null;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function mapBoardTask(task: DetailTask, allowArchived = false): MappedTask | null {
  const status = mapStatus(task.status, allowArchived);
  if (!status || !task.id || !task.title) return null;
  const updatedAt = Date.parse(task.updatedAt);
  const mapped: MappedTask = {
    id: task.id,
    title: task.title,
    status,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
  if (task.kind) mapped.agent = task.kind;
  if (task.summary) mapped.summary = clip(task.summary, 500);
  if (task.workspaceId && WORKSPACE_ID.test(task.workspaceId)) mapped.workspaceId = task.workspaceId;
  if (Number.isInteger(task.iteration) && task.iteration > 0) mapped.iteration = task.iteration;
  if (task.cwd && task.cwd.length <= 1024 && !task.cwd.includes("://")) mapped.cwd = task.cwd;
  if (task.model) mapped.model = fit(task.model, 200);
  if (task.sessionId) mapped.sessionId = fit(task.sessionId, 200);
  const startedAt = epoch(task.startedAt);
  if (startedAt != null) mapped.startedAt = startedAt;
  const endedAt = epoch(task.endedAt);
  if (endedAt != null) mapped.endedAt = endedAt;
  if (typeof task.exitCode === "number" && Number.isSafeInteger(task.exitCode)) mapped.exitCode = task.exitCode;
  if (typeof task.pid === "number" && Number.isSafeInteger(task.pid) && task.pid > 0) mapped.pid = task.pid;
  if (task.error) mapped.error = clip(task.error, 500);
  const prompt = clip(task.prompt, DETAIL_TEXT);
  if (prompt) mapped.prompt = prompt;
  if (task.promptTruncated || (task.prompt?.length ?? 0) > DETAIL_TEXT) mapped.promptTruncated = true;
  const turns = buildTurns(task);
  if (turns.length) mapped.turns = turns;
  const latest = [...turns].reverse().find((turn) => turn.output)?.output ?? clip(task.output, DETAIL_TEXT);
  if (latest) mapped.output = latest;
  if (task.outputTruncated || turnsDropped(task) || (task.output?.length ?? 0) > DETAIL_TEXT) mapped.outputTruncated = true;
  const command = resumeCommand({ kind: task.kind, sessionId: task.sessionId, cwd: task.cwd });
  if (command) mapped.resumeCommand = clip(command, 500);
  if (task.worktree?.branch) mapped.worktreeBranch = fit(task.worktree.branch, 200);
  const jobs = mapSideJobs(task.sideJobs);
  if (jobs.length) mapped.sideJobs = jobs;
  return mapped;
}

/**
 * Snapshot rows stay small. `full` is `evt.task` and `cmd.detail`: turns, side jobs,
 * and the longer prompt/reply text. `detail: "full"` tells the phone not to keep a
 * previous rich card when this frame replaces it.
 */
export function wireMappedTask(task: MappedTask, mode: "snapshot" | "full"): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
  };
  if (task.agent) wire.agent = task.agent;
  if (task.summary) wire.summary = task.summary;
  if (task.workspaceId) wire.workspaceId = task.workspaceId;
  if (task.iteration != null) wire.iteration = task.iteration;
  if (task.cwd) wire.cwd = task.cwd;
  if (task.model) wire.model = task.model;
  if (task.sessionId) wire.sessionId = task.sessionId;
  if (task.startedAt != null) wire.startedAt = task.startedAt;
  if (task.endedAt != null) wire.endedAt = task.endedAt;
  if (task.exitCode != null) wire.exitCode = task.exitCode;
  if (task.pid != null) wire.pid = task.pid;
  if (task.error) wire.error = mode === "snapshot" ? clip(task.error, 180) : task.error;
  if (task.resumeCommand) wire.resumeCommand = task.resumeCommand;
  if (task.worktreeBranch) wire.worktreeBranch = task.worktreeBranch;
  if (task.promptTruncated) wire.promptTruncated = true;
  if (task.outputTruncated) wire.outputTruncated = true;
  if (mode === "snapshot") {
    const promptPreview = clip(task.prompt, PREVIEW_TEXT);
    const outputPreview = clip(task.output, PREVIEW_TEXT);
    if (promptPreview) wire.promptPreview = promptPreview;
    if (outputPreview) wire.outputPreview = outputPreview;
    return wire;
  }
  wire.detail = "full";
  if (task.prompt) wire.prompt = task.prompt;
  if (task.output) wire.output = task.output;
  if (task.turns?.length) wire.turns = task.turns;
  if (task.sideJobs?.length) wire.sideJobs = task.sideJobs;
  return wire;
}

/** Status, title, agent, workspace, and the detail card. Output tail changes emit `evt.task`. */
export function taskSignature(task: MappedTask): string {
  const jobs = (task.sideJobs ?? []).map((job) => `${job.id}:${job.status}:${job.title}`).join(",");
  return [
    task.status,
    task.title,
    task.agent ?? "",
    task.workspaceId ?? "",
    task.iteration ?? "",
    task.sessionId ?? "",
    task.error ?? "",
    task.exitCode ?? "",
    task.cwd ?? "",
    task.model ?? "",
    task.worktreeBranch ?? "",
    task.resumeCommand ?? "",
    task.prompt?.length ?? 0,
    task.output?.length ?? 0,
    (task.output ?? "").slice(-40),
    jobs,
  ].join("\0");
}

export function isAgentKind(value: string): value is AgentKind {
  return (AGENTS as readonly string[]).includes(value);
}

export function agentList(): readonly AgentKind[] {
  return AGENTS;
}

function buildTurns(task: DetailTask): RelayTurn[] {
  const prompts = task.prompts?.length
    ? task.prompts
    : task.prompt
      ? [{ iteration: 1, prompt: task.prompt, at: task.startedAt }]
      : [];
  const outputs = task.outputs?.length
    ? task.outputs
    : task.output
      ? [{ iteration: task.iteration || 1, text: task.output, at: task.endedAt || task.updatedAt }]
      : [];
  const byIter = new Map<number, RelayTurn>();
  for (const prompt of prompts) addPrompt(byIter, prompt);
  for (const output of outputs) addOutput(byIter, output);
  return [...byIter.values()].sort((a, b) => a.iteration - b.iteration).slice(-MAX_TURNS);
}

function turnsDropped(task: DetailTask): boolean {
  const count = new Set<number>();
  for (const prompt of task.prompts ?? []) count.add(prompt.iteration);
  for (const output of task.outputs ?? []) count.add(output.iteration);
  if (!count.size && (task.prompt || task.output)) count.add(1);
  return count.size > MAX_TURNS;
}

function addPrompt(byIter: Map<number, RelayTurn>, prompt: PromptTurn): void {
  if (!Number.isInteger(prompt.iteration) || prompt.iteration < 1) return;
  const turn = byIter.get(prompt.iteration) ?? { iteration: prompt.iteration };
  const text = clip(prompt.prompt, DETAIL_TEXT);
  if (text) turn.prompt = text;
  const at = epoch(prompt.at);
  if (at != null) turn.at = at;
  byIter.set(prompt.iteration, turn);
}

function addOutput(byIter: Map<number, RelayTurn>, output: OutputTurn): void {
  if (!Number.isInteger(output.iteration) || output.iteration < 1) return;
  const turn = byIter.get(output.iteration) ?? { iteration: output.iteration };
  const text = clip(output.text, DETAIL_TEXT);
  if (text) turn.output = text;
  const at = epoch(output.at);
  if (at != null && turn.at == null) turn.at = at;
  byIter.set(output.iteration, turn);
}

function mapSideJobs(jobs: SideJob[] | undefined): RelaySideJob[] {
  if (!jobs?.length) return [];
  const out: RelaySideJob[] = [];
  for (const job of jobs) {
    if (out.length >= MAX_SIDE_JOBS) break;
    if (!job.id || !job.title || !job.status) continue;
    const mapped: RelaySideJob = {
      id: fit(job.id, 80),
      kind: fit(job.kind || "other", 32),
      title: fit(job.title, 120),
      status: fit(job.status, 32),
    };
    if (job.summary) mapped.summary = clip(job.summary, 240);
    if (job.toolName) mapped.toolName = fit(job.toolName, 80);
    out.push(mapped);
  }
  return out;
}

function fit(value: string, max: number): string {
  const flat = value.replace(/\u0000/g, "");
  return flat.length <= max ? flat : flat.slice(0, max);
}

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const flat = value.replace(/\u0000/g, "");
  if (!flat.trim()) return undefined;
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function epoch(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
