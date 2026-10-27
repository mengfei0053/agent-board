export type AgentKind = "pi" | "claude" | "cursor";

export type TaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "stopped";

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
