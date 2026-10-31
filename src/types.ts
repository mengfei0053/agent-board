export type AgentKind = "pi" | "claude" | "cursor" | "devin" | "codex";

export type TaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "stopped"
  | "archived";


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

/**
 * Board-owned git worktree created for this task.
 * `baseHead` is the commit recorded at create time and is informational only.
 * Delete checks `owned`, `path`, and `branch` — not `baseHead`.
 */
export type TaskWorktree = {
  path: string;
  branch: string;
  baseHead: string;
  owned: true;
};

/** File attached when creating a task (stored under data/uploads) */
export type TaskAttachment = {
  /** Stored filename on disk (safe id + ext) */
  name: string;
  /** Original client filename for display / download */
  originalName: string;
  /** Public URL path, e.g. /uploads/xxx.pdf */
  url: string;
  mime: string;
  size: number;
};

/** One assistant reply for a single start/continue iteration */
export type OutputTurn = {
  iteration: number;
  text: string;
  /** ISO time when this turn's text was last updated */
  at?: string;
};

/** User prompt for a single start/continue iteration (1 = initial, 2+ = continue) */
export type PromptTurn = {
  iteration: number;
  prompt: string;
  /** ISO time when this prompt was submitted */
  at?: string;
};

/** Board swimlane keys */
export type BoardLane = "draft" | "todo" | "running" | "done" | "archived";

/** Per-workspace overrides applied when starting tasks in this space */
export type WorkspaceSettings = {
  /** System / space prompt prepended on first run (and continue without session) */
  systemPrompt?: string;
  /** Skill names or paths (one entry each) */
  skills?: string[];
  /**
   * MCP config for this workspace.
   * Free-form JSON or prose; persisted and surfaced to the agent via prompt
   * until native per-CLI MCP wiring exists.
   */
  mcp?: string;
};

export type Workspace = {
  id: string;
  name: string;
  /** Absolute path used as task cwd */
  path: string;
  createdAt: string;
  updatedAt: string;
  /** Optional space-level prompt / skills / mcp */
  settings?: WorkspaceSettings;
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
  /** Per-iteration user prompts (1 = create prompt, each continue +1) */
  prompts?: PromptTurn[];
  lastEvent?: string;
  error?: string;
  exitCode?: number | null;
  /** Sub-agents / background bash / monitors parsed from event stream */
  sideJobs?: SideJob[];
  /** Files attached at create time */
  attachments?: TaskAttachment[];
  /** Set when this task was created inside a board-owned git worktree. */
  worktree?: TaskWorktree;
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
  attachments?: TaskAttachment[];
  /**
   * When true, create a git worktree under the resolved cwd and spawn there.
   * Omitted or false keeps the workspace / cwd path. Non-boolean values are
   * rejected at the HTTP boundary.
   */
  useGitWorktree?: boolean;
};

export type CreateWorkspaceInput = {
  name: string;
  path: string;
};

export type UpdateWorkspaceInput = {
  name?: string;
  path?: string;
  settings?: WorkspaceSettings;
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
