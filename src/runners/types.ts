import type { Task } from "../types.js";

export type RunnerHooks = {
  onStatus: (patch: Partial<Task>) => void;
  /** `source` is set for child stdout/stderr. Omitted for board-authored lines. */
  onLog: (line: string, source?: "stdout" | "stderr") => void;
};

export type RunnerHandle = {
  pid?: number;
  stop: () => void;
  /** Resolves when the child has exited, or immediately if nothing was spawned. */
  settled?: Promise<void>;
  /** SIGTERM, then SIGKILL, then wait until exit or `timeoutMs`. */
  stopAndWait?: (timeoutMs?: number) => Promise<void>;
};

export type RunnerStartOptions = {
  /** Follow-up prompt when resuming the same CLI session */
  continuePrompt?: string;
};

export type Runner = {
  start: (task: Task, hooks: RunnerHooks, opts?: RunnerStartOptions) => RunnerHandle;
};
