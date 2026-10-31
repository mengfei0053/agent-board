import type { BoardEvent } from "../types.js";
import { RelayCursor, type RelayFrame } from "./cursor.js";
import { eventsFromBoardEvent } from "./dialect.js";
import type { Envelope } from "./envelope.js";
import { RelayCommandError, relayErrorFrom } from "./errors.js";
import type { BoardFacade } from "./facade.js";
import { CreateIdempotency } from "./idempotency.js";
import { RELAY_LIMITS } from "./limits.js";
import { isAgentKind, mapBoardTask, type MappedTask } from "./map.js";
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

  constructor(
    private readonly opts: {
      generation: number;
      boardId: string;
      facade: BoardFacade;
      idempotency: CreateIdempotency;
      send: RelaySender;
      onOverflow: () => void;
      onFatal: (err: unknown) => void;
      log?: LogFn;
    },
  ) {
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
    if (
      message.type !== "cmd.create"
      && message.type !== "cmd.continue"
      && message.type !== "cmd.stop"
    ) {
      return;
    }
    try {
      if (message.type === "cmd.create") {
        await this.applyCreate(message);
        return;
      }
      if (message.type === "cmd.stop" || message.type === "cmd.continue") {
        await this.applyTaskCommand(message);
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
      task: wireMapped(task),
    }, message.id);
  }

  private async applyTaskCommand(message: Envelope): Promise<void> {
    const parsed = parseTaskCommand(message.payload, this.opts.boardId);
    if (!parsed.ok) {
      this.fail(message, new RelayCommandError(parsed.code, parsed.message));
      return;
    }
    const task = message.type === "cmd.stop"
      ? await this.opts.facade.stop(parsed.taskId)
      : await this.opts.facade.continue(parsed.taskId);
    const mapped = mapBoardTask(task);
    if (!mapped) throw new RelayCommandError("board_http", "board request failed");
    if (this.closed) return;
    this.opts.send("ack", {
      ref: message.id,
      stage: "executed",
      boardId: this.opts.boardId,
      idempotencyKey: parsed.key,
      task: wireMapped(mapped),
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

function wireMapped(task: MappedTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
  };
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
  return {
    ok: true,
    key: key.key,
    input: {
      kind: agent,
      title: payload.title,
      prompt: payload.prompt,
      cwd: payload.cwd,
      ...(payload.useGitWorktree === true ? { useGitWorktree: true } : {}),
    },
  };
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
  if (!cwd.trim()) return "cwd is required";
  if (cwd.length > 1024) return "cwd is too long";
  if ([...cwd].some((ch) => ch < " " || ch === "\u007f")) return "cwd is invalid";
  if (cwd.includes("://")) return "cwd must be a local path";
  if (!cwd.startsWith("/")) return "cwd must be an absolute path";
  return null;
}
