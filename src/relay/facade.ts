import { nanoid } from "nanoid";
import { publish as publishBoardEvent, subscribe } from "../bus.js";
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
import { deleteWorkspace as removeWorkspace, getTask as readStoredTask, upsertWorkspace as saveWorkspace } from "../store.js";
import type { AgentKind, BoardEvent, CreateTaskInput, Task, Workspace } from "../types.js";
import { RelayCommandError, relayErrorFrom } from "./errors.js";
import { isAgentKind, WORKSPACE_ID } from "./map.js";

export type FacadeCreateInput = {
  kind: AgentKind;
  title: string;
  prompt: string;
  cwd: string;
  /** Only `true` is forwarded. `false` and omission leave the workspace path. */
  useGitWorktree?: boolean;
  /**
   * When set, the task is filed in this workspace and cwd comes from its path.
   * Same rule as `POST /api/tasks`.
   */
  workspaceId?: string;
};

export type FacadeWorkspaceInput = {
  name: string;
  path: string;
};

export type BoardFacade = {
  /** Synchronous task baseline. Already passed through `presentBoardTask`. */
  boardSnapshot(): Task[];
  workspaceSnapshot(): Workspace[];
  /** `ok: true` only when git worktree eligibility succeeds. Throws on probe failure. */
  gitEligibility(path: string): Promise<{ ok: boolean }>;
  create(input: FacadeCreateInput): Promise<Task>;
  stop(id: string): Promise<Task>;
  /** Raw task for `cmd.detail`. Not the clipped list snapshot. */
  task(id: string): Task | undefined;
  continue(id: string, prompt?: string): Promise<Task>;
  /** Same store path as `POST /api/workspaces` (`name` + `path` only). */
  createWorkspace(input: FacadeWorkspaceInput): Promise<Workspace>;
  /**
   * Same store path as `DELETE /api/workspaces/:id`.
   * Refuses the default workspace and any workspace that still has tasks.
   */
  deleteWorkspace(id: string): Promise<void>;
  subscribe(fn: (ev: BoardEvent) => void): () => void;
};

export type BoardFacadeDeps = {
  boardSnapshot?: () => Task[];
  workspaceSnapshot?: () => Workspace[];
  gitEligibility?: (path: string) => Promise<{ ok: boolean }>;
  createAndStart?: (input: CreateTaskInput) => Promise<Task>;
  stopTask?: (id: string) => Promise<Task>;
  task?: (id: string) => Task | undefined;
  continueTask?: (id: string, prompt?: string) => Promise<Task>;
  subscribe?: (fn: (ev: BoardEvent) => void) => () => void;
  resolveAllowedDirectory?: (input: string, label?: string) => string;
  upsertWorkspace?: (ws: Workspace) => Promise<Workspace>;
  removeWorkspace?: (id: string) => Promise<boolean>;
  publish?: (ev: BoardEvent) => void;
  allocateWorkspaceId?: () => string;
  now?: () => string;
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
  const upsert = deps.upsertWorkspace ?? saveWorkspace;
  const remove = deps.removeWorkspace ?? removeWorkspace;
  const emit = deps.publish ?? publishBoardEvent;
  const allocateId = deps.allocateWorkspaceId ?? (() => nanoid(10));
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    boardSnapshot: () => snapshot(),
    workspaceSnapshot: () => spaces(),
    gitEligibility: (path) => eligibility(path),
    subscribe: (fn) => listen(fn),
    create: (input) => createWithHttpGates(input, start, resolveDir),
    createWorkspace: (input) => createWorkspaceWithGates(input, resolveDir, upsert, emit, allocateId, now),
    deleteWorkspace: (id) => deleteWorkspaceWithGates(id, remove, emit),
    stop: async (id) => {
      try {
        return await stop(id);
      } catch (err) {
        throw relayErrorFrom(err);
      }
    },
    task: (id) => (deps.task ? deps.task(id) : readStoredTask(id)),
    continue: async (id, prompt) => {
      try {
        return await cont(id, prompt);
      } catch (err) {
        if (err instanceof Error && err.message === "task is still running; stop it before continue") {
          throw new RelayCommandError("bad_request", err.message);
        }
        if (err instanceof Error && err.message.startsWith("draft has no session")) {
          throw new RelayCommandError("bad_request", "draft has no session yet; start it first");
        }
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
  if (input.workspaceId != null && input.workspaceId !== "" && !WORKSPACE_ID.test(input.workspaceId)) {
    throw new RelayCommandError("bad_request", "workspaceId is invalid");
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
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.useGitWorktree === true ? { useGitWorktree: true } : {}),
  };
  try {
    return await start(body);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("workspace not found:")) {
      throw new RelayCommandError("bad_request", "workspace not found");
    }
    if (err instanceof HttpError || err instanceof RelayCommandError || (err instanceof Error && err.message === "not found")) {
      throw relayErrorFrom(err);
    }
    throw relayErrorFrom(err);
  }
}

/**
 * Mirrors `POST /api/workspaces`: trim the name, resolve the path, then upsert.
 * Settings are not accepted on this phone command.
 */
async function createWorkspaceWithGates(
  input: FacadeWorkspaceInput,
  resolveDir: (input: string, label?: string) => string,
  upsert: (ws: Workspace) => Promise<Workspace>,
  emit: (ev: BoardEvent) => void,
  allocateId: () => string,
  now: () => string,
): Promise<Workspace> {
  if (typeof input.name !== "string") throw new RelayCommandError("bad_request", "name is required");
  try {
    assertTextLimit(input.name, MAX_TITLE_CHARS, "name");
  } catch (err) {
    throw relayErrorFrom(err);
  }
  const name = input.name.trim();
  if (!name) throw new RelayCommandError("bad_request", "name is required");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new RelayCommandError("bad_request", "name is invalid");
  let path: string;
  try {
    path = resolveDir(input.path, "path");
  } catch (err) {
    throw pathCommandError(err);
  }
  const stamp = now();
  const ws: Workspace = { id: allocateId(), name, path, createdAt: stamp, updatedAt: stamp };
  try {
    await upsert(ws);
  } catch (err) {
    throw relayErrorFrom(err);
  }
  emit({ type: "workspace_upsert", workspace: ws });
  return ws;
}

/** Mirrors `DELETE /api/workspaces/:id`, including the store's refusal messages. */
async function deleteWorkspaceWithGates(
  id: string,
  remove: (id: string) => Promise<boolean>,
  emit: (ev: BoardEvent) => void,
): Promise<void> {
  if (!WORKSPACE_ID.test(id)) throw new RelayCommandError("bad_request", "workspaceId is invalid");
  try {
    const ok = await remove(id);
    if (!ok) throw new RelayCommandError("not_found", "workspace not found");
  } catch (err) {
    if (err instanceof RelayCommandError) throw err;
    if (err instanceof Error && err.message === "cannot delete the default workspace") {
      throw new RelayCommandError("bad_request", err.message);
    }
    if (err instanceof Error && err.message.startsWith("workspace still has tasks")) {
      throw new RelayCommandError("bad_request", "workspace still has tasks; move or delete them first");
    }
    throw relayErrorFrom(err);
  }
  emit({ type: "workspace_delete", workspaceIds: [id] });
}

/** Path failures stay generic. The phone must not see the rejected path. */
function pathCommandError(err: unknown): RelayCommandError {
  if (err instanceof RelayCommandError) return err;
  if (err instanceof HttpError) {
    const msg = err.message;
    if (/^path required/i.test(msg)) return new RelayCommandError("bad_request", "path is required");
    if (/must be an absolute path/i.test(msg)) return new RelayCommandError("bad_request", "path must be an absolute path");
    if (/not a directory/i.test(msg)) return new RelayCommandError("bad_request", "path is not a directory");
    if (/outside allowed roots/i.test(msg)) return new RelayCommandError("bad_request", "path is outside allowed roots");
    if (/not found/i.test(msg)) return new RelayCommandError("bad_request", "path not found");
    if (err.statusCode >= 500) return new RelayCommandError("board_http", "board request failed");
    return new RelayCommandError("bad_request", "bad request");
  }
  return relayErrorFrom(err);
}
