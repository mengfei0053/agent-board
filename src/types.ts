export type AgentKind = "pi" | "claude" | "cursor";

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

/** Board swimlane keys */
export type BoardLane = "draft" | "todo" | "running" | "done";

export type Task = {
  id: string;
  title: string;
  kind: AgentKind;
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
  /** Final assistant reply (markdown/plain), extracted from logs */
  output?: string;
  lastEvent?: string;
  error?: string;
  exitCode?: number | null;
  /** Sub-agents / background bash / monitors parsed from event stream */
  sideJobs?: SideJob[];
};

export type CreateTaskInput = {
  title?: string;
  kind: AgentKind;
  cwd: string;
  prompt: string;
  model?: string;
};

export type ContinueTaskInput = {
  prompt?: string;
};

export type BoardEvent =
  | { type: "task_upsert"; task: Task }
  | { type: "task_delete"; taskIds: string[] }
  | { type: "task_log"; taskId: string; line: string; at: string }
  | { type: "hello"; tasks: Task[] };
