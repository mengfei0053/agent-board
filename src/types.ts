export type AgentKind = "pi" | "claude" | "cursor";

export type TaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "stopped";

export type Task = {
  id: string;
  title: string;
  kind: AgentKind;
  cwd: string;
  prompt: string;
  model?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  pid?: number;
  summary?: string;
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

export type BoardEvent =
  | { type: "task_upsert"; task: Task }
  | { type: "task_log"; taskId: string; line: string; at: string }
  | { type: "hello"; tasks: Task[] };
