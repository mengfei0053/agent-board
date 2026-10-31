import { mapArchiveRow, pageArchiveRows, wireArchiveRow } from "./archive.js";
import { BoardHttpError, type BoardClient } from "./board.js";
import { EventCursor, type Outbound } from "./cursor.js";
import { eventsFromBoardSse } from "./dialect.js";
import { buildCreateBody, mapBoardTask, taskPayload, type MappedTask } from "./map.js";
import { consumeSse } from "./sse.js";
import { deletedWorkspaceIds, demoteWorkspaces, sseKind, stubsFromSseData, type ThinWorkspace, type WorkspaceStub } from "./workspaces.js";

type Envelope = Outbound | { v: 1; id: string; type: string; ts: number; payload?: Record<string, unknown> };

const CREATE_LIMIT = 500;

/**
 * Maps relay commands onto loopback agent-board HTTP and emits protocol events.
 * The board token never enters this object.
 */
export class ConnectorSession {
  private readonly cursor: EventCursor;
  private readonly known = new Map<string, MappedTask>();
  private readonly creates = new Map<string, MappedTask>();
  private workspaces: ThinWorkspace[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly boardId: string,
    private readonly api: BoardClient,
    private readonly send: (message: Envelope) => void,
    generation: number,
  ) {
    this.cursor = new EventCursor(boardId);
    this.cursor.reset(generation);
  }

  async onRegistered(generation: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.cursor.generation !== generation) {
        this.cursor.reset(generation);
        this.known.clear();
      }
      const tasks = await this.api.listTasks();
      for (const task of tasks) this.known.set(task.id, task);
      await this.refreshWorkspaces([]);
      this.send(this.cursor.snapshot([...this.known.values()], Date.now(), this.workspaces));
    });
  }

  onMessage(message: Envelope): Promise<void> {
    return this.enqueue(() => this.handle(message));
  }

  ingest(name: string, data: string): Promise<void> {
    return this.enqueue(() => this.applySse(name, data));
  }

  async streamEvents(signal: AbortSignal, onOpen?: () => void): Promise<void> {
    const response = await fetch(new URL("/api/events", this.api.base), {
      headers: { accept: "text/event-stream" },
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400) throw new BoardHttpError(response.status, "/api/events");
    if (!response.ok || !response.body) throw new BoardHttpError(response.status, "/api/events");
    onOpen?.();
    await consumeSse(response.body, (event, data) => {
      void this.ingest(event, data).catch(() => undefined);
    });
    if (!signal.aborted) throw new Error("board event stream ended");
  }

  private async handle(message: Envelope): Promise<void> {
    if (
      message.type !== "cmd.create"
      && message.type !== "cmd.continue"
      && message.type !== "cmd.stop"
      && message.type !== "cmd.archive.list"
      && message.type !== "cmd.detail"
    ) return;
    const payload = message.payload ?? {};
    if (payload.boardId !== undefined && payload.boardId !== this.boardId) {
      this.fail(message.id, "forbidden", "command boardId does not match this connector");
      return;
    }
    try {
      if (message.type === "cmd.create") await this.create(message.id, payload);
      else if (message.type === "cmd.continue") await this.continueTask(message.id, payload);
      else if (message.type === "cmd.stop") await this.stopTask(message.id, payload);
      else if (message.type === "cmd.archive.list") await this.archiveList(message.id, payload);
      else await this.detail(message.id, payload);
    } catch (error) {
      if (error instanceof BoardHttpError) {
        const code = error.status === 404 ? "task_not_found" : "board_http";
        this.fail(message.id, code, error.message);
        return;
      }
      this.fail(message.id, "board_http", "local board request failed");
    }
  }

  private async create(ref: string, payload: Record<string, unknown>): Promise<void> {
    const built = buildCreateBody(payload);
    if (!built.ok) {
      this.fail(ref, built.code, built.message);
      return;
    }
    const cached = this.creates.get(built.idempotencyKey);
    if (cached) {
      this.ack(ref, cached);
      return;
    }
    const task = await this.api.createTask(built.body);
    this.remember(built.idempotencyKey, task);
    this.known.set(task.id, task);
    this.emitAll(this.cursor.observe(task));
    this.ack(ref, task);
  }

  private async continueTask(ref: string, payload: Record<string, unknown>): Promise<void> {
    const taskId = payload.taskId;
    if (typeof taskId !== "string" || !taskId) {
      this.fail(ref, "bad_request", "taskId is required");
      return;
    }
    const task = await this.api.continueTask(taskId);
    this.known.set(task.id, task);
    this.emitAll(this.cursor.observe(task));
    this.ack(ref, task);
  }

  private async stopTask(ref: string, payload: Record<string, unknown>): Promise<void> {
    const taskId = payload.taskId;
    if (typeof taskId !== "string" || !taskId) {
      this.fail(ref, "bad_request", "taskId is required");
      return;
    }
    const task = await this.api.stopTask(taskId);
    this.known.set(task.id, task);
    this.emitAll(this.cursor.observe(task));
    this.ack(ref, task);
  }

  private async archiveList(ref: string, payload: Record<string, unknown>): Promise<void> {
    const key = payload.idempotencyKey;
    if (typeof key !== "string" || key.length < 8) {
      this.fail(ref, "bad_request", "idempotencyKey is required");
      return;
    }
    let limit = 20;
    if (payload.limit !== undefined) {
      if (typeof payload.limit !== "number" || !Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 50) {
        this.fail(ref, "bad_request", "limit is invalid");
        return;
      }
      limit = payload.limit;
    }
    let cursor: string | undefined;
    if (payload.cursor !== undefined && payload.cursor !== null && payload.cursor !== "") {
      if (typeof payload.cursor !== "string") {
        this.fail(ref, "bad_request", "cursor is invalid");
        return;
      }
      cursor = payload.cursor;
    }
    const records = await this.api.listTaskRecords();
    const rows = records.flatMap((item) => {
      const row = mapArchiveRow(item, false);
      return row ? [row] : [];
    });
    const page = pageArchiveRows(rows, cursor, limit);
    if (!page.ok) {
      this.fail(ref, "bad_request", page.message);
      return;
    }
    this.send({
      v: 1,
      id: cryptoRandom(),
      type: "ack",
      ts: Date.now(),
      payload: {
        ref,
        stage: "executed",
        boardId: this.boardId,
        idempotencyKey: key,
        archive: {
          tasks: page.tasks.map((row) => wireArchiveRow(row, false)),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      },
    });
  }

  private async detail(ref: string, payload: Record<string, unknown>): Promise<void> {
    const taskId = payload.taskId;
    const key = payload.idempotencyKey;
    if (typeof taskId !== "string" || !taskId) {
      this.fail(ref, "bad_request", "taskId is required");
      return;
    }
    if (typeof key !== "string" || key.length < 8) {
      this.fail(ref, "bad_request", "idempotencyKey is required");
      return;
    }
    let raw: unknown;
    try {
      raw = await this.api.getTaskRecord(taskId);
    } catch (error) {
      if (error instanceof BoardHttpError && error.status === 404) {
        this.fail(ref, "task_not_found", "task not found");
        return;
      }
      throw error;
    }
    const archived = mapArchiveRow(raw, true);
    if (archived) {
      this.send({
        v: 1,
        id: cryptoRandom(),
        type: "ack",
        ts: Date.now(),
        payload: {
          ref,
          stage: "executed",
          boardId: this.boardId,
          idempotencyKey: key,
          task: wireArchiveRow(archived, true),
        },
      });
      return;
    }
    const live = mapBoardTask(raw);
    if (!live) {
      this.fail(ref, "bad_request", "task is not available");
      return;
    }
    this.send({
      v: 1,
      id: cryptoRandom(),
      type: "ack",
      ts: Date.now(),
      payload: { ref, stage: "executed", boardId: this.boardId, idempotencyKey: key, task: taskPayload(live) },
    });
  }

  private async applySse(name: string, data: string): Promise<void> {
    const kind = sseKind(name, data);
    if (kind === "hello" || kind === "workspace_upsert") {
      await this.refreshWorkspaces(stubsFromSseData(data));
    } else if (kind === "workspace_delete") {
      await this.refreshWorkspaces([], deletedWorkspaceIds(data));
    }
    this.emitAll(eventsFromBoardSse(this.cursor, this.known, name, data, this.workspaces));
  }

  /**
   * The board computes isGit. A failed eligibility check is false, not a guess.
   * The in-memory create map is not durable: after a connector restart a lost ack can create again.
   */
  private async refreshWorkspaces(fallback: WorkspaceStub[], removeIds: string[] = []): Promise<void> {
    try {
      this.workspaces = await this.enrich(await this.api.listWorkspaces());
      return;
    } catch {
      // Do not keep the previous isGit bit after a failed refresh.
    }
    if (removeIds.length > 0) {
      const drop = new Set(removeIds);
      this.workspaces = demoteWorkspaces(this.workspaces.filter((row) => !drop.has(row.id)));
      return;
    }
    if (fallback.length > 0) {
      this.workspaces = await this.enrich(fallback);
      return;
    }
    this.workspaces = demoteWorkspaces(this.workspaces);
  }

  private async enrich(stubs: WorkspaceStub[]): Promise<ThinWorkspace[]> {
    const rows: ThinWorkspace[] = [];
    for (const stub of stubs.slice(0, 50)) {
      let isGit = false;
      try {
        isGit = await this.api.workspaceIsGit(stub.id);
      } catch {
        isGit = false;
      }
      rows.push({ ...stub, isGit });
    }
    return rows;
  }

  private emitAll(events: Envelope[]): void {
    for (const event of events) this.send(event);
  }

  private ack(ref: string, task: MappedTask): void {
    this.send({
      v: 1,
      id: cryptoRandom(),
      type: "ack",
      ts: Date.now(),
      payload: { ref, stage: "executed", task: taskPayload(task) },
    });
  }

  private fail(ref: string, code: string, message: string): void {
    this.send({
      v: 1,
      id: cryptoRandom(),
      type: "err",
      ts: Date.now(),
      payload: { ref, code, message: message.slice(0, 500) },
    });
  }

  private remember(key: string, task: MappedTask): void {
    if (this.creates.has(key)) this.creates.delete(key);
    this.creates.set(key, task);
    while (this.creates.size > CREATE_LIMIT) {
      const oldest = this.creates.keys().next().value;
      if (oldest === undefined) break;
      this.creates.delete(oldest);
    }
  }

  private enqueue(work: () => Promise<void> | void): Promise<void> {
    const run = this.tail.then(work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function cryptoRandom(): string {
  return globalThis.crypto.randomUUID();
}
