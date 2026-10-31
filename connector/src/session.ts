import { mapArchiveRow, pageArchiveRows, wireArchiveRow } from "./archive.js";
import { BoardHttpError, type BoardClient } from "./board.js";
import { phoneWorkspaceCard, type PhoneWorkspaceCard } from "./workspaceCard.js";
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
  private readonly settingsPuts = new Map<string, unknown>();
  private readonly workspaceUpdates = new Map<string, unknown>();
  private readonly archives = new Map<string, string>();
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
      && message.type !== "cmd.archive"
      && message.type !== "cmd.detail"
      && message.type !== "cmd.workspace.get"
      && message.type !== "cmd.workspace.update"
      && message.type !== "cmd.settings.get"
      && message.type !== "cmd.settings.put"
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
      else if (message.type === "cmd.archive") await this.archive(message.id, payload);
      else if (message.type === "cmd.workspace.get") await this.workspaceGet(message.id, payload);
      else if (message.type === "cmd.workspace.update") await this.workspaceUpdate(message.id, payload);
      else if (message.type === "cmd.settings.get") await this.settingsGet(message.id, payload);
      else if (message.type === "cmd.settings.put") await this.settingsPut(message.id, payload);
      else await this.detail(message.id, payload);
    } catch (error) {
      if (error instanceof BoardHttpError) {
        const mapped = mapBoardFailure(error);
        this.fail(message.id, mapped.code, mapped.message);
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
    let workspaceId: string | undefined;
    if (payload.workspaceId !== undefined && payload.workspaceId !== null && payload.workspaceId !== "") {
      if (typeof payload.workspaceId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(payload.workspaceId)) {
        this.fail(ref, "bad_request", "workspaceId is invalid");
        return;
      }
      workspaceId = payload.workspaceId;
    }
    const records = await this.api.listTaskRecords();
    const rows = records.flatMap((item) => {
      const row = mapArchiveRow(item, false);
      return row ? [row] : [];
    });
    const page = pageArchiveRows(rows, cursor, limit, workspaceId);
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
          ...(page.restarted ? { restarted: true } : {}),
        },
      },
    });
  }

  private async archive(ref: string, payload: Record<string, unknown>): Promise<void> {
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
    const cached = this.archives.get(key);
    const archivedId = cached ?? taskId;
    if (!cached) {
      await this.api.archiveTask(taskId);
      this.rememberArchive(key, taskId);
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
        archived: true,
        taskId: archivedId,
      },
    });
  }

  private async workspaceGet(ref: string, payload: Record<string, unknown>): Promise<void> {
    const key = payload.idempotencyKey;
    const workspaceId = payload.workspaceId;
    if (typeof key !== "string" || key.length < 8) {
      this.fail(ref, "bad_request", "idempotencyKey is required");
      return;
    }
    if (typeof workspaceId !== "string" || !workspaceId) {
      this.fail(ref, "bad_request", "workspaceId is invalid");
      return;
    }
    const card = await this.loadWorkspaceCard(workspaceId);
    if (!card) {
      this.fail(ref, "not_found", "workspace not found");
      return;
    }
    this.send(executed(ref, this.boardId, key, { workspace: card }));
  }

  private async workspaceUpdate(ref: string, payload: Record<string, unknown>): Promise<void> {
    const key = payload.idempotencyKey;
    const workspaceId = payload.workspaceId;
    if (typeof key !== "string" || key.length < 8) {
      this.fail(ref, "bad_request", "idempotencyKey is required");
      return;
    }
    if (typeof workspaceId !== "string" || !workspaceId) {
      this.fail(ref, "bad_request", "workspaceId is invalid");
      return;
    }
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      this.fail(ref, "bad_request", "name is required");
      return;
    }
    if (typeof payload.path !== "string" || !payload.path.trim()) {
      this.fail(ref, "bad_request", "path is required");
      return;
    }
    if (!isRecord(payload.settings)) {
      this.fail(ref, "bad_request", "settings must be an object");
      return;
    }
    for (const field of ["systemPrompt", "skills", "mcp"]) {
      if (!(field in payload.settings)) {
        this.fail(ref, "bad_request", `settings.${field} is required`);
        return;
      }
    }
    const cached = this.workspaceUpdates.get(key);
    if (cached) {
      this.send(executed(ref, this.boardId, key, { workspace: cached }));
      return;
    }
    const saved = await this.api.patchWorkspace(workspaceId, {
      name: payload.name.trim(),
      path: payload.path.trim(),
      settings: payload.settings,
    });
    const card = await this.loadWorkspaceCard(workspaceId, saved);
    if (!card) {
      this.fail(ref, "board_http", "board request failed");
      return;
    }
    this.rememberWorkspace(key, card);
    this.send(executed(ref, this.boardId, key, { workspace: card }));
  }

  private async settingsGet(ref: string, payload: Record<string, unknown>): Promise<void> {
    const key = payload.idempotencyKey;
    if (typeof key !== "string" || key.length < 8) {
      this.fail(ref, "bad_request", "idempotencyKey is required");
      return;
    }
    const settings = await this.api.getSettings();
    this.send(executed(ref, this.boardId, key, { settings }));
  }

  /** Reject `clear` before the request. Do not log `payload` — it may hold a proxy password. */
  private async settingsPut(ref: string, payload: Record<string, unknown>): Promise<void> {
    const key = payload.idempotencyKey;
    if (typeof key !== "string" || key.length < 8) {
      this.fail(ref, "bad_request", "idempotencyKey is required");
      return;
    }
    if (payload.clear === true) {
      this.fail(ref, "bad_request", "clear is not allowed");
      return;
    }
    const cached = this.settingsPuts.get(key);
    if (cached) {
      this.send(executed(ref, this.boardId, key, { settings: cached }));
      return;
    }
    const body: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(payload)) {
      if (field === "boardId" || field === "idempotencyKey") continue;
      body[field] = value;
    }
    const settings = await this.api.putSettings(body);
    this.rememberSettings(key, settings);
    this.send(executed(ref, this.boardId, key, { settings }));
  }

  private async loadWorkspaceCard(id: string, known?: unknown): Promise<PhoneWorkspaceCard | null> {
    let record = known;
    if (!record) {
      try {
        record = await this.api.getWorkspaceRecord(id);
      } catch (error) {
        if (error instanceof BoardHttpError && error.status === 404) return null;
        throw error;
      }
    }
    let isGit = false;
    try {
      isGit = await this.api.workspaceIsGit(id);
    } catch {
      isGit = false;
    }
    let gitStatus: unknown = null;
    let gitFailed = false;
    try {
      gitStatus = await this.api.workspaceGitStatus(id);
    } catch {
      gitFailed = true;
    }
    const card = phoneWorkspaceCard(record, isGit, gitStatus, gitFailed);
    return card;
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

  private rememberSettings(key: string, settings: unknown): void {
    this.settingsPuts.set(key, settings);
    trimMap(this.settingsPuts, CREATE_LIMIT);
  }

  private rememberWorkspace(key: string, card: PhoneWorkspaceCard): void {
    this.workspaceUpdates.set(key, card);
    trimMap(this.workspaceUpdates, CREATE_LIMIT);
  }

  private rememberArchive(key: string, taskId: string): void {
    this.archives.set(key, taskId);
    trimMap(this.archives, CREATE_LIMIT);
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

function executed(ref: string, boardId: string, key: string, extra: Record<string, unknown>): Envelope {
  return {
    v: 1,
    id: cryptoRandom(),
    type: "ack",
    ts: Date.now(),
    payload: { ref, stage: "executed", boardId, idempotencyKey: key, ...extra },
  };
}

function mapBoardFailure(error: BoardHttpError): { code: string; message: string } {
  if (error.code === "archived_readonly") return { code: error.code, message: error.detail || "archived tasks are read-only" };
  if (error.detail === "task is still running" || error.detail === "draft cannot be archived" || error.detail === "clear is not allowed") {
    return { code: "bad_request", message: error.detail };
  }
  if (error.status === 404) return { code: "task_not_found", message: "task not found" };
  return { code: "board_http", message: "local board request failed" };
}

function trimMap<T>(map: Map<string, T>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
