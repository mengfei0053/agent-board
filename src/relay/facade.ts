import { subscribe } from "../bus.js";
import { getGitWorktreeEligibility } from "../gitWorktree.js";
import { HttpError } from "../httpError.js";
import { assertTextLimit, MAX_PROMPT_CHARS, MAX_TITLE_CHARS } from "../limits.js";
import {
  boardSnapshot,
  continueTask,
  createAndStart,
  stopTask,
  workspaceSnapshot,
} from "../manager.js";
import { resolveAllowedDirectory } from "../paths.js";
import type { AgentKind, BoardEvent, CreateTaskInput, Task, Workspace } from "../types.js";
import { RelayCommandError, relayErrorFrom } from "./errors.js";
import { isAgentKind } from "./map.js";

export type FacadeCreateInput = {
  kind: AgentKind;
  title: string;
  prompt: string;
  cwd: string;
  /** Only `true` is forwarded. `false` and omission leave the workspace path. */
  useGitWorktree?: boolean;
};

export type BoardFacade = {
  /** Synchronous task baseline. Already passed through `presentBoardTask`. */
  boardSnapshot(): Task[];
  workspaceSnapshot(): Workspace[];
  /** `ok: true` only when git worktree eligibility succeeds. Throws on probe failure. */
  gitEligibility(path: string): Promise<{ ok: boolean }>;
  create(input: FacadeCreateInput): Promise<Task>;
  stop(id: string): Promise<Task>;
  continue(id: string): Promise<Task>;
  subscribe(fn: (ev: BoardEvent) => void): () => void;
};

export type BoardFacadeDeps = {
  boardSnapshot?: () => Task[];
  workspaceSnapshot?: () => Workspace[];
  gitEligibility?: (path: string) => Promise<{ ok: boolean }>;
  createAndStart?: (input: CreateTaskInput) => Promise<Task>;
  stopTask?: (id: string) => Promise<Task>;
  continueTask?: (id: string) => Promise<Task>;
  subscribe?: (fn: (ev: BoardEvent) => void) => () => void;
  resolveAllowedDirectory?: (input: string, label?: string) => string;
};

/**
 * In-process board API used by the dialer. `create` applies the same gates as
 * `POST /api/tasks` before `createAndStart`.
 */
export function createBoardFacade(deps: BoardFacadeDeps = {}): BoardFacade {
  const snapshot = deps.boardSnapshot ?? boardSnapshot;
  const spaces = deps.workspaceSnapshot ?? workspaceSnapshot;
  const eligibility = deps.gitEligibility ?? (async (path: string) => {
    const result = await getGitWorktreeEligibility(path);
    return { ok: result.ok };
  });
  const start = deps.createAndStart ?? createAndStart;
  const stop = deps.stopTask ?? stopTask;
  const cont = deps.continueTask ?? continueTask;
  const listen = deps.subscribe ?? subscribe;
  const resolveDir = deps.resolveAllowedDirectory ?? resolveAllowedDirectory;

  return {
    boardSnapshot: () => snapshot(),
    workspaceSnapshot: () => spaces(),
    gitEligibility: (path) => eligibility(path),
    subscribe: (fn) => listen(fn),
    create: (input) => createWithHttpGates(input, start, resolveDir),
    stop: async (id) => {
      try {
        return await stop(id);
      } catch (err) {
        throw relayErrorFrom(err);
      }
    },
    continue: async (id) => {
      try {
        return await cont(id);
      } catch (err) {
        throw relayErrorFrom(err);
      }
    },
  };
}

async function createWithHttpGates(
  input: FacadeCreateInput,
  start: (input: CreateTaskInput) => Promise<Task>,
  resolveDir: (input: string, label?: string) => string,
): Promise<Task> {
  if (!isAgentKind(input.kind)) {
    throw new RelayCommandError("unknown_agent", "unknown agent");
  }
  try {
    assertTextLimit(input.title, MAX_TITLE_CHARS, "title");
    assertTextLimit(input.prompt, MAX_PROMPT_CHARS, "prompt");
  } catch (err) {
    throw relayErrorFrom(err);
  }
  if (!input.title.trim()) throw new RelayCommandError("bad_request", "title is required");
  if (!input.prompt.trim()) throw new RelayCommandError("bad_request", "prompt is required");
  if (input.useGitWorktree != null && typeof input.useGitWorktree !== "boolean") {
    throw new RelayCommandError("bad_request", "useGitWorktree must be a boolean");
  }
  if (!input.cwd || !input.cwd.trim()) {
    throw new RelayCommandError("cwd_required", "cwd is required");
  }
  let cwd: string;
  try {
    cwd = resolveDir(input.cwd, "cwd");
  } catch (err) {
    throw relayErrorFrom(err);
  }
  const body: CreateTaskInput = {
    kind: input.kind,
    title: input.title.trim(),
    prompt: input.prompt,
    cwd,
    ...(input.useGitWorktree === true ? { useGitWorktree: true } : {}),
  };
  try {
    return await start(body);
  } catch (err) {
    if (err instanceof HttpError || err instanceof RelayCommandError || (err instanceof Error && err.message === "not found")) {
      throw relayErrorFrom(err);
    }
    throw relayErrorFrom(err);
  }
}
