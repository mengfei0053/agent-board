import type { AgentKind, Task } from "../types.js";

const AGENTS: readonly AgentKind[] = ["pi", "claude", "cursor", "devin", "codex"];

export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped"]);

export type RelayStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "stopped";

/** Same alphabet as board workspace ids (`nanoid`) plus the board-id punctuation. */
export const WORKSPACE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

/** Phone-facing task. `updatedAt` is epoch milliseconds. Archived tasks are omitted. */
export type MappedTask = {
  id: string;
  title: string;
  status: RelayStatus;
  updatedAt: number;
  agent?: string;
  summary?: string;
  /** Omitted when the board task has no usable workspace id. */
  workspaceId?: string;
};

export function mapStatus(status: string): RelayStatus | null {
  if (status === "draft" || status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "blocked") return "paused";
  if (status === "succeeded" || status === "failed" || status === "stopped") return status;
  return null;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function mapBoardTask(
  task: Pick<Task, "id" | "title" | "kind" | "status" | "updatedAt" | "summary"> & { workspaceId?: string },
): MappedTask | null {
  const status = mapStatus(task.status);
  if (!status || !task.id || !task.title) return null;
  const updatedAt = Date.parse(task.updatedAt);
  const mapped: MappedTask = {
    id: task.id,
    title: task.title,
    status,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
  if (task.kind) mapped.agent = task.kind;
  if (task.summary) mapped.summary = task.summary;
  if (task.workspaceId && WORKSPACE_ID.test(task.workspaceId)) mapped.workspaceId = task.workspaceId;
  return mapped;
}

/** Title, status, agent, and workspace. Unchanged signatures do not emit another `evt.task`. */
export function taskSignature(task: MappedTask): string {
  return `${task.status}\0${task.title}\0${task.agent ?? ""}\0${task.workspaceId ?? ""}`;
}

export function isAgentKind(value: string): value is AgentKind {
  return (AGENTS as readonly string[]).includes(value);
}

export function agentList(): readonly AgentKind[] {
  return AGENTS;
}
