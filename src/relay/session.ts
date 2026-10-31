import type { BoardEvent } from "../types.js";
import { RelayCursor, type RelayFrame } from "./cursor.js";
import { eventsFromBoardEvent } from "./dialect.js";
import type { Envelope } from "./envelope.js";
import { RelayCommandError, relayErrorFrom } from "./errors.js";
import type { BoardFacade } from "./facade.js";
import { CreateIdempotency, WorkspaceIdempotency } from "./idempotency.js";
import { RELAY_LIMITS } from "./limits.js";
import { pageArchivedTasks, wireArchivePage } from "./archive.js";
import { isAgentKind, mapBoardTask, wireMappedTask, WORKSPACE_ID, type MappedTask } from "./map.js";
import { enrichWorkspaces } from "./workspaces.js";

const VISIBLE_KEY = /^[\x21-\x7E]{8,80}$/;

type SessionJob = {
  command: boolean;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export type RelaySender = (type: string, payload: Record<string, unknown>, id?: string) => void;

type LogFn = (level: "info" | "warn" | "error", message: string) => void;

/**
 * One relay generation. The constructor subscribes and captures the task
 * baseline synchronously. `bootstrap` may await workspace enrichment, then
 * emits one snapshot, drains buffered bus events, and only then should the
 * caller deliver pre-session commands.
 */
export class ConnectorSession {
  private readonly cursor: RelayCursor;
  private readonly buffer: BoardEvent[] = [];
  private readonly baseline: MappedTask[];
  private unsub: () => void;
  private closed = false;
  private overflowed = false;
  private acceptLive = false;
  private pumpQueued = false;
  private pendingCommands = 0;
  private drainingJobs = false;
  private readonly jobs: SessionJob[] = [];
  private readonly workspaceOps: WorkspaceIdempotency;

  constructor(
    private readonly opts: {
      generation: number;
      boardId: string;
      facade: BoardFacade;
      idempotency: CreateIdempotency;
      /** Shared across generations. Defaults to a session-local cache. */
      workspaceIdempotency?: WorkspaceIdempotency;
      send: RelaySender;
      onOverflow: () => void;
      onFatal: (err: unknown) => void;
      log?: LogFn;
    },
  ) {
    this.workspaceOps = opts.workspaceIdempotency ?? new WorkspaceIdempotency();
    this.cursor = new RelayCursor(opts.generation);
    this.unsub = opts.facade.subscribe((ev) => this.onBus(ev));
    this.baseline = opts.facade.boardSnapshot().flatMap((task) => {
      const mapped = mapBoardTask(task);
      return mapped ? [mapped] : [];
    });
  }

  async bootstrap(): Promise<void> {
    const workspaces = await enrichWorkspaces(
      this.opts.facade.workspaceSnapshot(),
      (path) => this.opts.facade.gitEligibility(path),
    );
    if (this.overflowed) throw new Error("bus buffer overflow");
    if (this.closed) return;
    await this.enqueue(async () => {
      this.emit(this.cursor.buildSnapshot(this.opts.boardId, this.baseline, workspaces));
      this.acceptLive = true;
      await this.drain();
    });
    await this.enqueue(async () => {
      await this.drain();
    });
  }

  handleCommand(message: Envelope): void {
    if (this.closed || this.overflowed) return;
    if (!isLiveCommand(message.type)) return;
    if (this.pendingCommands >= RELAY_LIMITS.maxLiveCommands) {
      this.fail(message, new RelayCommandError("rate_limited", "relay command queue is full"));
      this.overflowed = true;
      this.opts.onOverflow();
      return;
    }
    this.pendingCommands += 1;
    void this.enqueue(async () => {
      try {
        await this.applyCommand(message);
      } finally {
        this.pendingCommands -= 1;
      }
    }, true).catch(() => {});
  }

  /** Commands accepted but not started. Zero after `close` drops them. */
  queuedCommandCount(): number {
    return this.jobs.reduce((count, job) => count + (job.command ? 1 : 0), 0);
  }

  close(): void {
    this.closed = true;
    this.buffer.length = 0;
    this.dropQueuedJobs();
    try {
      this.unsub();
    } catch {
      /* ignore */
    }
    this.unsub = () => {};
  }

  private onBus(ev: BoardEvent): void {
    if (this.closed) return;
    if (this.buffer.length >= RELAY_LIMITS.maxBusBuffer) {
      if (!this.overflowed) {
        this.overflowed = true;
        this.opts.onOverflow();
      }
      return;
    }
    this.buffer.push(ev);
    if (this.acceptLive) this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpQueued || this.closed) return;
    this.pumpQueued = true;
    void this.enqueue(async () => {
      this.pumpQueued = false;
      try {
        await this.drain();
      } catch (err) {
        this.opts.onFatal(err);
      }
    }).catch(() => {});
  }

  /**
   * Serial jobs for this generation. `close` drops every job that has not
   * started. The one already running — including a dialer-lifetime
   * `facade.create` — is left alone.
   */
  private enqueue(job: () => Promise<void>, command = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.jobs.push({ command, run: job, resolve, reject });
    this.pumpJobs();
    return done;
  }

  private pumpJobs(): void {
    if (this.drainingJobs) return;
    this.drainingJobs = true;
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (this.jobs.length) {
        if (this.closed) {
          this.dropQueuedJobs();
          break;
        }
        const job = this.jobs.shift();
        if (!job) break;
        try {
          await job.run();
          job.resolve();
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.drainingJobs = false;
      if (!this.closed && this.jobs.length) this.pumpJobs();
    }
  }

  private dropQueuedJobs(): void {
    const dropped = this.jobs.splice(0);
    for (const job of dropped) {
      if (job.command) this.pendingCommands -= 1;
      job.resolve();
    }
  }

  private async drain(): Promise<void> {
    while (this.buffer.length && !this.closed) {
      if (this.overflowed) throw new Error("bus buffer overflow");
      const ev = this.buffer.shift();
      if (!ev) break;
      await this.applyEvent(ev);
    }
  }

  private async applyEvent(ev: BoardEvent): Promise<void> {
    const result = eventsFromBoardEvent(this.cursor, ev, this.opts.boardId);
    for (const frame of result.frames) this.emit(frame);
    if (!result.needsSnapshot || this.closed) return;
    const tasks = this.opts.facade.boardSnapshot().flatMap((task) => {
      const mapped = mapBoardTask(task);
      return mapped ? [mapped] : [];
    });
    const workspaces = await enrichWorkspaces(
      this.opts.facade.workspaceSnapshot(),
      (path) => this.opts.facade.gitEligibility(path),
    );
    if (this.closed || this.overflowed) return;
    this.emit(this.cursor.refreshSnapshot(this.opts.boardId, tasks, workspaces));
  }

  private async applyCommand(message: Envelope): Promise<void> {
    if (this.closed || this.overflowed) return;
    if (!isLiveCommand(message.type)) return;
    try {
      if (message.type === "cmd.create") {
        await this.applyCreate(message);
        return;
      }
      if (message.type === "cmd.workspace.create") {
        await this.applyWorkspaceCreate(message);
        return;
      }
      if (message.type === "cmd.workspace.delete") {
        await this.applyWorkspaceDelete(message);
        return;
      }
      if (message.type === "cmd.stop" || message.type === "cmd.continue") {
        await this.applyTaskCommand(message);
        return;
      }
      if (message.type === "cmd.detail") {
        await this.applyDetail(message);
        return;
      }
      if (message.type === "cmd.archive.list") {
        await this.applyArchiveList(message);
        return;
      }
      this.fail(message, new RelayCommandError("bad_request", "unsupported command"));
    } catch (err) {
      this.fail(message, relayErrorFrom(err));
    }
  }

  private async applyCreate(message: Envelope): Promise<void> {
    const parsed = parseCreate(message.payload, this.opts.boardId);
    if (!parsed.ok) {
      this.fail(message, new RelayCommandError(parsed.code, parsed.message));
      return;
    }
    const { key, input } = parsed;
    const task = await this.opts.idempotency.run(key, async () => {
      const created = await this.opts.facade.create(input);
      const mapped = mapBoardTask(created);
      if (!mapped) throw new RelayCommandError("board_http", "board request failed");
      return mapped;
    });
    if (this.closed) return;
    this.opts.send("ack", {
      ref: message.id,
      stage: "executed",
      boardId: this.opts.boardId,
      idempotencyKey: key,
      task: wireMappedTask(task, "full"),
    }, message.id);
  }

  private async applyTaskCommand(message: Envelope): Promise<void> {
    const parsed = parseTaskCommand(message.payload, this.opts.boardId);
    if (!parsed.ok) {
      this.fail(message, new RelayCommandError(parsed.code, parsed.message));
      return;
    }
    const prompt = message.type === "cmd.continue" ? readContinuePrompt(message.payload) : { ok: true as const, prompt: undefined };
    if (!prompt.ok) {
      this.fail(message, new RelayCommandError(prompt.code, prompt.message));
      return;
    }
    const task = message.type === "cmd.stop"
      ? await this.opts.facade.stop(parsed.taskId)
      : await this.opts.facade.continue(parsed.taskId, prompt.prompt);
    const mapped = mapBoardTask(task);
    if (!mapped) throw new RelayCommandError("board_http", "board request failed");
    if (this.closed) return;
    this.opts.send("ack", {
      ref: message.id,
      stage: "executed",
      boardId: this.opts.boardId,
      idempotencyKey: parsed.key,
      task: wireMappedTask(mapped, "full"),
    }, message.id);
  }

  private async applyDetail(message: Envelope): Promise<void> {
    const parsed = parseTaskCommand(message.payload, this.opts.boardId);
    if (!parsed.ok) {
      this.fail(message, new RelayCommandError(parsed.code, parsed.message));
      return;
    }
    const task = this.opts.facade.task(parsed.taskId);
    if (!task) {
      this.fail(message, new RelayCommandError("task_not_found", "task not found"));
      return;
    }
    const mapped = mapBoardTask(task, true);
    if (!mapped) {
      this.fail(message, new RelayCommandError("bad_request", "task is not available"));
      return;
    }
    if (this.closed) return;
    this.opts.send("ack", {
      ref: message.id,
      stage: "executed",
      boardId: this.opts.boardId,
      idempotencyKey: parsed.key,
      task: wireMappedTask(mapped, "full"),
    }, message.id);
  }

  private async applyArchiveList(message: Envelope): Promise<void> {
    const parsed = parseArchiveList(message.payload, this.opts.boardId);
    if (!parsed.ok) {
      this.fail(message, new RelayCommandError(parsed.code, parsed.message));
      return;
    }
    const page = pageArchivedTasks(this.opts.facade.boardSnapshot(), parsed.cursor, parsed.limit);
    if (!page.ok) {
      this.fail(message, new RelayCommandError("bad_request", page.message));
      return;
    }
    if (this.closed) return;
    this.opts.send("ack", {
      ref: message.id,
      stage: "executed",
      boardId: this.opts.boardId,
      idempotencyKey: parsed.key,
      archive: wireArchivePage(page.page),
    }, message.id);
  }

  private async applyWorkspaceCreate(message: Envelope): Promise<void> {
    const parsed = parseWorkspaceCreate(message.payload, this.opts.boardId);
    if (!parsed.ok) {
      this.fail(message, new RelayCommandError(parsed.code, parsed.message));
      return;
    }
    const workspace = await this.workspaceOps.runCreate(parsed.key, () => this.opts.facade.createWorkspace(parsed.input));
    if (this.closed) return;
    let isGit = false;
    try {
      isGit = (await this.opts.facade.gitEligibility(workspace.path)).ok === true;
    } catch {
      isGit = false;
    }
    if (this.closed) return;
    this.opts.send("ack", {
      ref: message.id,
      stage: "executed",
      boardId: this.opts.boardId,
      idempotencyKey: parsed.key,
      workspace: { id: workspace.id, name: workspace.name, path: workspace.path, isGit },
    }, message.id);
  }

  private async applyWorkspaceDelete(message: Envelope): Promise<void> {
    const parsed = parseWorkspaceDelete(message.payload, this.opts.boardId);
    if (!parsed.ok) {
      this.fail(message, new RelayCommandError(parsed.code, parsed.message));
      return;
    }
    const deleted = await this.workspaceOps.runDelete(parsed.key, async () => {
      await this.opts.facade.deleteWorkspace(parsed.workspaceId);
      return parsed.workspaceId;
    });
    if (this.closed) return;
    this.opts.send("ack", {
      ref: message.id,
      stage: "executed",
      boardId: this.opts.boardId,
      idempotencyKey: parsed.key,
      deleted,
    }, message.id);
  }

  private fail(message: Envelope, err: unknown): void {
    if (this.closed) return;
    const safe = relayErrorFrom(err);
    this.opts.log?.("warn", `relay command ${message.type} failed: ${safe.code}`);
    this.opts.send("err", {
      ref: message.id,
      code: safe.code,
      message: safe.message,
      boardId: this.opts.boardId,
    }, message.id);
  }

  private emit(frame: RelayFrame): void {
    if (this.closed) return;
    this.opts.send(frame.type, frame.payload);
  }
}

function isLiveCommand(type: string): boolean {
  return type === "cmd.create"
    || type === "cmd.continue"
    || type === "cmd.stop"
    || type === "cmd.detail"
    || type === "cmd.archive.list"
    || type === "cmd.workspace.create"
    || type === "cmd.workspace.delete";
}

function readContinuePrompt(
  payload: Record<string, unknown>,
): { ok: true; prompt?: string } | { ok: false; code: string; message: string } {
  if (!("prompt" in payload) || payload.prompt == null || payload.prompt === "") return { ok: true };
  if (typeof payload.prompt !== "string") return { ok: false, code: "bad_request", message: "prompt must be a string" };
  const prompt = payload.prompt.trim();
  if (!prompt) return { ok: true };
  if (prompt.length > 20_000) return { ok: false, code: "bad_request", message: "prompt is too long" };
  if ([...prompt].some((ch) => ch === "\u0000")) return { ok: false, code: "bad_request", message: "prompt is invalid" };
  return { ok: true, prompt };
}

type ParsedCreate =
  | { ok: true; key: string; input: Parameters<BoardFacade["create"]>[0] }
  | { ok: false; code: string; message: string };

function parseCreate(payload: Record<string, unknown>, boardId: string): ParsedCreate {
  const foreign = requireBoard(payload, boardId);
  if (foreign) return foreign;
  const key = requireKey(payload);
  if (!key.ok) return key;
  const agent = typeof payload.agent === "string" ? payload.agent : "";
  if (!isAgentKind(agent)) return { ok: false, code: "unknown_agent", message: "unknown agent" };
  if (typeof payload.title !== "string" || !payload.title.trim()) {
    return { ok: false, code: "bad_request", message: "title is required" };
  }
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
    return { ok: false, code: "bad_request", message: "prompt is required" };
  }
  if (!("cwd" in payload) || payload.cwd == null || payload.cwd === "") {
    return { ok: false, code: "cwd_required", message: "cwd is required" };
  }
  if (typeof payload.cwd !== "string") {
    return { ok: false, code: "bad_request", message: "cwd must be a string" };
  }
  const cwdError = localCwdError(payload.cwd);
  if (cwdError) return { ok: false, code: "bad_request", message: cwdError };
  if ("useGitWorktree" in payload && payload.useGitWorktree != null && typeof payload.useGitWorktree !== "boolean") {
    return { ok: false, code: "bad_request", message: "useGitWorktree must be a boolean" };
  }
  let workspaceId: string | undefined;
  if ("workspaceId" in payload && payload.workspaceId != null && payload.workspaceId !== "") {
    if (typeof payload.workspaceId !== "string" || !WORKSPACE_ID.test(payload.workspaceId)) {
      return { ok: false, code: "bad_request", message: "workspaceId is invalid" };
    }
    workspaceId = payload.workspaceId;
  }
  return {
    ok: true,
    key: key.key,
    input: {
      kind: agent,
      title: payload.title,
      prompt: payload.prompt,
      cwd: payload.cwd,
      ...(workspaceId ? { workspaceId } : {}),
      ...(payload.useGitWorktree === true ? { useGitWorktree: true } : {}),
    },
  };
}

function parseWorkspaceCreate(
  payload: Record<string, unknown>,
  boardId: string,
): { ok: true; key: string; input: { name: string; path: string } } | { ok: false; code: string; message: string } {
  const foreign = requireBoard(payload, boardId);
  if (foreign) return foreign;
  const key = requireKey(payload);
  if (!key.ok) return key;
  if (typeof payload.name !== "string") return { ok: false, code: "bad_request", message: "name is required" };
  const name = payload.name.trim();
  if (!name || name.length > 200) return { ok: false, code: "bad_request", message: "name is required" };
  if ([...name].some((ch) => ch < " " || ch === "\u007f")) {
    return { ok: false, code: "bad_request", message: "name is invalid" };
  }
  if (typeof payload.path !== "string") return { ok: false, code: "bad_request", message: "path is required" };
  const pathError = localPathError(payload.path, "path");
  if (pathError) return { ok: false, code: "bad_request", message: pathError };
  return { ok: true, key: key.key, input: { name, path: payload.path.trim() } };
}

function parseWorkspaceDelete(
  payload: Record<string, unknown>,
  boardId: string,
): { ok: true; key: string; workspaceId: string } | { ok: false; code: string; message: string } {
  const foreign = requireBoard(payload, boardId);
  if (foreign) return foreign;
  const key = requireKey(payload);
  if (!key.ok) return key;
  const workspaceId = payload.workspaceId;
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
    return { ok: false, code: "bad_request", message: "workspaceId is invalid" };
  }
  return { ok: true, key: key.key, workspaceId };
}

function parseArchiveList(
  payload: Record<string, unknown>,
  boardId: string,
): { ok: true; key: string; limit: number; cursor?: string } | { ok: false; code: string; message: string } {
  const foreign = requireBoard(payload, boardId);
  if (foreign) return foreign;
  const key = requireKey(payload);
  if (!key.ok) return key;
  let limit = 20;
  if ("limit" in payload && payload.limit != null) {
    if (typeof payload.limit !== "number" || !Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 50) {
      return { ok: false, code: "bad_request", message: "limit is invalid" };
    }
    limit = payload.limit;
  }
  let cursor: string | undefined;
  if ("cursor" in payload && payload.cursor != null && payload.cursor !== "") {
    if (typeof payload.cursor !== "string" || !/^([0-9]{1,16}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(payload.cursor)) {
      return { ok: false, code: "bad_request", message: "cursor is invalid" };
    }
    cursor = payload.cursor;
  }
  return { ok: true, key: key.key, limit, ...(cursor ? { cursor } : {}) };
}

function parseTaskCommand(
  payload: Record<string, unknown>,
  boardId: string,
): { ok: true; key: string; taskId: string } | { ok: false; code: string; message: string } {
  const foreign = requireBoard(payload, boardId);
  if (foreign) return foreign;
  const key = requireKey(payload);
  if (!key.ok) return key;
  const taskId = payload.taskId;
  if (typeof taskId !== "string" || !taskId.trim()) {
    return { ok: false, code: "bad_request", message: "taskId is required" };
  }
  if (taskId.length > 64 || /[^\x21-\x7E]/.test(taskId)) {
    return { ok: false, code: "bad_request", message: "taskId is invalid" };
  }
  return { ok: true, key: key.key, taskId };
}

function requireBoard(
  payload: Record<string, unknown>,
  boardId: string,
): { ok: false; code: string; message: string } | null {
  const claimed = payload.boardId;
  if (typeof claimed !== "string" || claimed !== boardId) {
    return { ok: false, code: "forbidden", message: "boardId does not match this board" };
  }
  return null;
}

function requireKey(
  payload: Record<string, unknown>,
): { ok: true; key: string } | { ok: false; code: string; message: string } {
  const key = payload.idempotencyKey;
  if (typeof key !== "string" || !VISIBLE_KEY.test(key)) {
    return { ok: false, code: "bad_request", message: "idempotencyKey must be 8-80 visible ASCII characters" };
  }
  return { ok: true, key };
}

function localCwdError(cwd: string): string | null {
  return localPathError(cwd, "cwd");
}

function localPathError(value: string, label: string): string | null {
  if (!value.trim()) return `${label} is required`;
  if (value.length > 1024) return `${label} is too long`;
  if ([...value].some((ch) => ch < " " || ch === "\u007f")) return `${label} is invalid`;
  if (value.includes("://")) return `${label} must be a local path`;
  if (!value.startsWith("/")) return `${label} must be an absolute path`;
  return null;
}
