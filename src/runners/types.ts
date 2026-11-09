import type { Task } from "../types.js";

export type RunnerHooks = {
  onStatus: (patch: Partial<Task>) => void;
  /** `source` is set for child stdout/stderr. Omitted for board-authored lines. */
  onLog: (line: string, source?: "stdout" | "stderr") => void;
};

export type RunnerHandle = {
  pid?: number;
  stop: () => void;
  /** Send a message to the running session without interrupting the run. */
  steer?: (prompt: string) => boolean;
  /** Write raw data to child stdin when spawned with stdinPipe: true. */
  writeStdin?: (data: string) => boolean;
  /** Close child stdin when spawned with stdinPipe: true. */
  endStdin?: () => void;
  /** Resolves when the child has exited, or immediately if nothing was spawned. */
  settled?: Promise<void>;
  /** SIGTERM, then SIGKILL, then wait until exit or `timeoutMs`. */
  stopAndWait?: (timeoutMs?: number) => Promise<void>;
};

export type RunnerStartOptions = {
  /** Follow-up prompt when resuming the same CLI session */
  continuePrompt?: string;
  /** Current workspace MCP configuration, refreshed even when resuming. */
  workspaceMcp?: string;
};

export type Runner = {
  start: (task: Task, hooks: RunnerHooks, opts?: RunnerStartOptions) => RunnerHandle;
};
