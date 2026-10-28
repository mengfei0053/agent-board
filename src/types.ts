export type AgentKind = "pi" | "claude" | "cursor" | "devin";

export type TaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "stopped";


/** Background / sub-agent / monitor jobs observed in the agent event stream */
export type SideJobKind = "agent" | "task" | "monitor" | "background" | "other";

export type SideJobStatus = "running" | "succeeded" | "failed" | "stopped" | "unknown";

export type SideJob = {
  id: string;
  kind: SideJobKind;
  /** Short label for UI */
  title: string;
  summary?: string;
  status: SideJobStatus;
  toolName?: string;
  startedAt?: string;
  endedAt?: string;
};

/** One assistant reply for a single start/continue iteration */
export type OutputTurn = {
  iteration: number;
  text: string;
  /** ISO time when this turn's text was last updated */
  at?: string;
};

/** Board swimlane keys */
export type BoardLane = "draft" | "todo" | "running" | "done";

export type Workspace = {
  id: string;
  name: string;
  /** Absolute path used as task cwd */
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  title: string;
  kind: AgentKind;
  /** Workspace this task belongs to */
  workspaceId: string;
  cwd: string;
  prompt: string;
  model?: string;
  /** CLI session / chat id used for resume/continue */
  sessionId?: string;
  /** How many runs this task has had (1 on create, +1 each continue) */
  iteration: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  pid?: number;
  summary?: string;
  /** Latest assistant reply (markdown/plain); mirrors outputs[-1].text */
  output?: string;
  /** Per-iteration assistant outputs (start = 1, each continue +1) */
  outputs?: OutputTurn[];
  lastEvent?: string;
  error?: string;
  exitCode?: number | null;
  /** Sub-agents / background bash / monitors parsed from event stream */
  sideJobs?: SideJob[];
};

export type CreateTaskInput = {
  title?: string;
  kind: AgentKind;
  /** Preferred: create under this workspace (cwd taken from workspace.path) */
  workspaceId?: string;
  /** Fallback when workspaceId omitted (webhook / legacy) */
  cwd?: string;
  prompt: string;
  model?: string;
};

export type CreateWorkspaceInput = {
  name: string;
  path: string;
};

export type UpdateWorkspaceInput = {
  name?: string;
  path?: string;
};

export type ContinueTaskInput = {
  prompt?: string;
};

export type BoardEvent =
  | { type: "task_upsert"; task: Task }
  | { type: "task_delete"; taskIds: string[] }
  | { type: "task_log"; taskId: string; line: string; at: string }
  | { type: "workspace_upsert"; workspace: Workspace }
  | { type: "workspace_delete"; workspaceIds: string[] }
  | { type: "hello"; tasks: Task[]; workspaces: Workspace[] };
