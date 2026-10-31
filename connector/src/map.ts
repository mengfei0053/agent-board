export const AGENT_KINDS = ["pi", "claude", "cursor", "devin", "codex"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const PROTOCOL_STATUSES = ["queued", "running", "paused", "succeeded", "failed", "stopped"] as const;
export type ProtocolStatus = (typeof PROTOCOL_STATUSES)[number];

const TERMINAL = new Set<ProtocolStatus>(["succeeded", "failed", "stopped"]);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type MappedTask = {
  id: string;
  title: string;
  status: ProtocolStatus;
  updatedAt: number;
  agent?: AgentKind;
};

export type CreateBody = {
  kind: AgentKind;
  prompt: string;
  title: string;
  cwd: string;
  start: true;
  useGitWorktree?: true;
};

export function isTerminalStatus(status: ProtocolStatus): boolean {
  return TERMINAL.has(status);
}

/** Board status → relay status. Archived and unknown statuses are not forwarded. */
export function mapStatus(boardStatus: string): ProtocolStatus | null {
  switch (boardStatus) {
    case "draft":
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "blocked":
      return "paused";
    case "succeeded":
    case "failed":
    case "stopped":
      return boardStatus;
    default:
      return null;
  }
}

export function mapBoardTask(raw: unknown): MappedTask | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!TASK_ID.test(id)) return null;
  const status = typeof raw.status === "string" ? mapStatus(raw.status) : null;
  if (!status) return null;
  const title = cleanText(typeof raw.title === "string" ? raw.title : "untitled", 200) || "untitled";
  const updatedAt = readTime(raw.updatedAt);
  const kindRaw = typeof raw.kind === "string" ? raw.kind : typeof raw.agent === "string" ? raw.agent : undefined;
  const task: MappedTask = { id, title, status, updatedAt };
  if (kindRaw && isAgentKind(kindRaw)) task.agent = kindRaw;
  return task;
}

export function buildCreateBody(payload: Record<string, unknown>): { ok: true; idempotencyKey: string; body: CreateBody } | { ok: false; code: string; message: string } {
  const idempotencyKey = payload.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    return { ok: false, code: "bad_request", message: "idempotencyKey is required" };
  }
  const agent = payload.agent;
  if (typeof agent !== "string" || !isAgentKind(agent)) {
    return { ok: false, code: "unknown_agent", message: "agent must be pi, claude, cursor, devin, or codex" };
  }
  const cwd = payload.cwd;
  if (typeof cwd !== "string" || !isSafePath(cwd)) {
    return { ok: false, code: "cwd_required", message: "cwd is required and must be a local path" };
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const title = typeof payload.title === "string" ? payload.title : "";
  if (!prompt.trim() || !title.trim()) {
    return { ok: false, code: "bad_request", message: "title and prompt are required" };
  }
  if (payload.useGitWorktree !== undefined && typeof payload.useGitWorktree !== "boolean") {
    return { ok: false, code: "bad_request", message: "useGitWorktree must be a boolean" };
  }
  const body: CreateBody = { kind: agent, prompt, title, cwd, start: true };
  if (payload.useGitWorktree === true) body.useGitWorktree = true;
  return { ok: true, idempotencyKey, body };
}

export function taskPayload(task: MappedTask): Record<string, string | number> {
  const payload: Record<string, string | number> = {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
  };
  if (task.agent) payload.agent = task.agent;
  return payload;
}

export function normalizeStream(value: unknown): "stdout" | "stderr" | "system" {
  if (value === "stdout" || value === "stderr" || value === "system") return value;
  return "system";
}

export function cleanLine(value: string): string {
  return cleanText(value, 8_000);
}

function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value);
}

function isSafePath(value: string): boolean {
  if (!value.trim() || value.length > 1024) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.includes("://")) return false;
  return true;
}

function cleanText(value: string, max: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max);
}

function readTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
