/** Map the local board HTTP model onto the phone relay protocol. */

const PHONE_STATUSES = new Set(["queued", "running", "paused", "succeeded", "failed", "stopped"]);

export type BoardTask = {
  id: string;
  title: string;
  kind?: string;
  status: string;
  updatedAt: string;
  summary?: string;
};

export type BoardWorkspace = {
  id: string;
  name: string;
  path: string;
};

export type RelayTask = {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  agent?: string;
};

export type ThinWorkspace = {
  id: string;
  name: string;
  path: string;
  isGit: boolean;
};

export function mapStatus(status: string): string | null {
  if (status === "draft") return "queued";
  if (status === "blocked") return "paused";
  if (status === "archived") return "stopped";
  return PHONE_STATUSES.has(status) ? status : null;
}

export function toRelayTask(task: BoardTask): RelayTask | null {
  const status = mapStatus(task.status);
  if (!status || !task.id || !task.title) return null;
  const updatedAt = Date.parse(task.updatedAt);
  return {
    id: task.id,
    title: task.title,
    status,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    agent: task.kind,
  };
}

export function toThinWorkspace(workspace: BoardWorkspace, isGit: boolean): ThinWorkspace | null {
  if (!workspace.id || !workspace.name || !workspace.path || workspace.path.includes("://")) return null;
  return { id: workspace.id, name: workspace.name, path: workspace.path, isGit };
}

export function createBody(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: payload.agent,
    title: payload.title,
    prompt: payload.prompt,
    cwd: payload.cwd,
    start: true,
    ...(payload.useGitWorktree === true ? { useGitWorktree: true } : {}),
  };
}
