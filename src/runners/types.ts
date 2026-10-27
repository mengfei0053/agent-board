import type { Task } from "../types.js";

export type RunnerHooks = {
  onStatus: (patch: Partial<Task>) => void;
  onLog: (line: string) => void;
};

export type RunnerHandle = {
  pid?: number;
  stop: () => void;
};

export type RunnerStartOptions = {
  /** Follow-up prompt when resuming the same CLI session */
  continuePrompt?: string;
};

export type Runner = {
  start: (task: Task, hooks: RunnerHooks, opts?: RunnerStartOptions) => RunnerHandle;
};
