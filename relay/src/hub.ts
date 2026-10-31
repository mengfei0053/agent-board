import { randomUUID } from "node:crypto";
import type { AuthStore } from "./auth.js";
import type { LogFields } from "./log.js";
import {
  ARCHIVE_CAPABILITY,
  makeAck,
  makeErr,
  parseMessage,
  type CommandType,
  type Envelope,
  type Incoming,
  type JsonObject,
} from "./protocol.js";

type LogFn = (level: "info" | "warn" | "error", message: string, fields?: LogFields) => void;

type Waiter = { phone: PhoneConn; requestId: string };

type CommandRecord = {
  commandId: string;
  idempotencyKey: string;
  boardId: string;
  /** Board socket that was forwarded this command. Another socket cannot complete it. */
  boardConnId: string;
  generation: number;
  type: CommandType;
  stage: "accepted" | "executed" | "failed" | "timeout";
  task?: JsonObject;
  archive?: JsonObject;
  workspace?: JsonObject;
  deleted?: string;
  errorCode?: string;
  errorMessage?: string;
  expiresAt: number;
  waiters: Waiter[];
  timer?: NodeJS.Timeout;
};

type Runtime = {
  generation: number;
  lastSeq: number;
  snapshot: Envelope | null;
  /** Task-state events after the current snapshot. Logs and done events are not stored here. */
  incremental: Envelope[];
  /** Log lines kept for sub.logs replay. A snapshot does not erase them. */
  logs: Envelope[];
  seenEventIds: Set<string>;
  terminalTasks: Set<string>;
  gapped: boolean;
  /** Set when a seq hole was rejected. Cleared by the next contiguous event. */
  seqGap: { expectedSeq: number; gotSeq: number } | null;
};

const PHONE_KINDS = new Set([
  "client.hello",
  "board.list",
  "sub.tasks",
  "sub.logs",
  "cmd.create",
  "cmd.continue",
  "cmd.stop",
  "cmd.workspace.create",
  "cmd.workspace.delete",
  "cmd.detail",
  "cmd.archive.list",
  "cmd.lookup",
]);

const BOARD_KINDS = new Set([
  "board.register",
  "evt.task",
  "evt.log",
  "evt.snapshot",
  "evt.task.done",
  "ack",
  "err",
]);

export class PhoneConn {
  deviceId: string | null = null;
  deviceName: string | null = null;
  token: string | null = null;
  boardIds: string[] = [];
  closed = false;
  readonly taskBoards = new Set<string>();
  readonly logBoards = new Map<string, Set<string> | null>();
  readonly seenEventIds = new Set<string>();

  constructor(
    readonly id: string,
    readonly send: (message: Envelope) => void,
    readonly closeSocket: () => void,
  ) {}
}

export class BoardConn {
  boardId: string | null = null;
  label: string | null = null;
  generation = 0;
  credentialId: string | null = null;
  connectedAt: number | null = null;
  /** Feature flags from board.register. Empty on boards that do not advertise any. */
  capabilities: string[] = [];
  closed = false;

  constructor(
    readonly id: string,
    readonly send: (message: Envelope) => void,
    readonly closeSocket: () => void,
  ) {}
}

/**
 * In-memory router. Pairings, commands, snapshots, and sockets are not persisted.
 * Offline commands are rejected. evt.task.done is forwarded only to phones that
 * are connected and allowed to see that board.
 */
export class RelayHub {
  private readonly boards = new Map<string, BoardConn>();
  private readonly phones = new Set<PhoneConn>();
  private readonly runtime = new Map<string, Runtime>();
  private readonly commands = new Map<string, CommandRecord>();
  private readonly commandByRelayId = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly auth: AuthStore,
    private readonly opts: {
      cmdTimeoutMs: number;
      idempotencyTtlMs?: number;
      now?: () => number;
      log?: LogFn;
    },
  ) {}

  attachPhone(send: (message: Envelope) => void, closeSocket: () => void): PhoneConn {
    const conn = new PhoneConn(randomUUID(), send, closeSocket);
    this.phones.add(conn);
    return conn;
  }

  attachBoard(send: (message: Envelope) => void, closeSocket: () => void): BoardConn {
    return new BoardConn(randomUUID(), send, closeSocket);
  }

  handlePhone(conn: PhoneConn, raw: unknown): void {
    if (this.disposed || conn.closed) return;
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      this.deliver(conn.send, makeErr(this.now(), parsed.message, { code: parsed.code, ref: parsed.id, stage: "failed" }));
      return;
    }
    if (!PHONE_KINDS.has(parsed.kind)) {
      this.deliver(conn.send, makeErr(this.now(), `phones cannot send ${parsed.kind}`, { code: "forbidden", ref: parsed.envelope.id, stage: "failed" }));
      return;
    }
    if (parsed.kind !== "client.hello" && !this.sessionLive(conn, parsed.envelope.id)) return;
    switch (parsed.kind) {
      case "client.hello":
        this.hello(conn, parsed);
        return;
      case "board.list":
        this.listBoards(conn, parsed.envelope.id);
        return;
      case "sub.tasks":
        this.subscribeTasks(conn, parsed.boardId, parsed.envelope.id, parsed.afterSeq);
        return;
      case "sub.logs":
        this.subscribeLogs(conn, parsed.boardId, parsed.taskId, parsed.envelope.id);
        return;
      case "cmd.lookup":
        this.lookup(conn, parsed);
        return;
      case "cmd.create":
      case "cmd.continue":
      case "cmd.stop":
      case "cmd.workspace.create":
      case "cmd.workspace.delete":
      case "cmd.detail":
      case "cmd.archive.list":
        this.forwardCmd(conn, parsed);
        return;
      default:
        return;
    }
  }

  handleBoard(conn: BoardConn, raw: unknown): void {
    if (this.disposed || conn.closed) return;
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      this.deliver(conn.send, makeErr(this.now(), parsed.message, { code: parsed.code, ref: parsed.id, stage: "failed" }));
      return;
    }
    if (!BOARD_KINDS.has(parsed.kind)) {
      this.deliver(conn.send, makeErr(this.now(), `boards cannot send ${parsed.kind}`, { code: "forbidden", ref: parsed.envelope.id, stage: "failed" }));
      return;
    }
    if (parsed.kind !== "board.register" && !conn.boardId) {
      this.deliver(conn.send, makeErr(this.now(), "send board.register first", { code: "unauthorized", ref: parsed.envelope.id, stage: "failed" }));
      return;
    }
    switch (parsed.kind) {
      case "board.register":
        this.register(conn, parsed);
        return;
      case "ack":
        this.resolveCommand(conn, parsed.ref, { type: "ack", envelope: parsed.envelope });
        return;
      case "err":
        this.resolveCommand(conn, parsed.ref, { type: "err", code: parsed.code, message: parsed.errMessage });
        return;
      case "evt.task":
      case "evt.log":
      case "evt.snapshot":
      case "evt.task.done":
        this.publish(conn, parsed);
        return;
      default:
        return;
    }
  }

  disconnectPhone(conn: PhoneConn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.phones.delete(conn);
    for (const record of this.commands.values()) {
      record.waiters = record.waiters.filter((waiter) => waiter.phone !== conn);
    }
  }

  disconnectBoard(conn: BoardConn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.releaseBoard(conn, "board_disconnected", "board disconnected");
  }

  kickDevice(deviceId: string): void {
    for (const phone of [...this.phones]) {
      if (phone.deviceId !== deviceId) continue;
      this.dropPhone(phone, "device token revoked");
    }
  }

  /** Drop sockets still authenticated with a token that refresh just replaced. */
  kickToken(token: string): void {
    if (!token) return;
    for (const phone of [...this.phones]) {
      if (phone.token !== token) continue;
      this.dropPhone(phone, "device token is no longer valid");
    }
  }

  kickCredential(credentialId: string): void {
    for (const board of [...this.boards.values()]) {
      if (board.credentialId !== credentialId) continue;
      this.deliver(board.send, makeErr(this.now(), "board token revoked", { code: "revoked", stage: "failed" }));
      const boardId = board.boardId;
      this.disconnectBoard(board);
      board.closeSocket();
      if (boardId) this.noteKick(boardId);
    }
  }

  kickBoard(boardId: string): void {
    const board = this.boards.get(boardId);
    if (!board) return;
    this.deliver(board.send, makeErr(this.now(), "board revoked", { code: "revoked", stage: "failed" }));
    this.disconnectBoard(board);
    board.closeSocket();
  }

  dispose(): void {
    this.disposed = true;
    for (const record of this.commands.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    this.commands.clear();
    this.commandByRelayId.clear();
  }

  stats(): { boardsOnline: number; phonesOnline: number; pairedDevices: number } {
    let phonesOnline = 0;
    for (const phone of this.phones) {
      if (phone.deviceId && !phone.closed) phonesOnline += 1;
    }
    return { boardsOnline: this.boards.size, phonesOnline, pairedDevices: this.auth.deviceCount() };
  }

  private hello(conn: PhoneConn, parsed: Extract<Incoming, { kind: "client.hello" }>): void {
    if (conn.deviceId) {
      this.deliver(conn.send, makeErr(this.now(), "already authenticated", { code: "already_authenticated", ref: parsed.envelope.id, stage: "failed" }));
      return;
    }
    const session = this.auth.verifyDevice(parsed.token);
    if (!session || session.role !== "phone") {
      this.deliver(conn.send, makeErr(this.now(), "device token rejected", { code: "unauthorized", ref: parsed.envelope.id, stage: "failed" }));
      return;
    }
    conn.deviceId = session.deviceId;
    conn.deviceName = session.deviceName;
    conn.token = parsed.token;
    conn.boardIds = [...session.boardIds];
    this.log("info", "phone authenticated", { deviceId: session.deviceId });
    this.deliver(conn.send, makeAck(this.now(), parsed.envelope.id, {
      stage: "executed",
      deviceId: session.deviceId,
      role: "phone",
      boardIds: conn.boardIds,
    }));
  }

  private register(conn: BoardConn, parsed: Extract<Incoming, { kind: "board.register" }>): void {
    const check = this.auth.verifyBoard(parsed.token, parsed.boardId);
    if (!check.ok) {
      this.deliver(conn.send, makeErr(this.now(), check.message, { code: check.code, ref: parsed.envelope.id, stage: "failed" }));
      return;
    }
    if (conn.boardId === parsed.boardId && this.boards.get(parsed.boardId) === conn) {
      if (parsed.label) conn.label = parsed.label;
      this.deliver(conn.send, makeAck(this.now(), parsed.envelope.id, {
        stage: "executed",
        boardId: parsed.boardId,
        generation: conn.generation,
      }));
      return;
    }
    if (conn.boardId && conn.boardId !== parsed.boardId) {
      this.releaseBoard(conn, "board_disconnected", "board socket rebound");
    }
    const existing = this.boards.get(parsed.boardId);
    if (existing && existing !== conn) {
      this.releaseBoard(existing, "board_disconnected", "board connection replaced");
      existing.closed = true;
      this.deliver(existing.send, makeErr(this.now(), "superseded by a new board connection", { code: "replaced", stage: "failed" }));
      existing.closeSocket();
    }
    const previous = this.runtime.get(parsed.boardId);
    const generation = (previous?.generation ?? 0) + 1;
    this.runtime.set(parsed.boardId, {
      generation,
      lastSeq: 0,
      snapshot: null,
      incremental: [],
      logs: previous?.logs ?? [],
      seenEventIds: new Set(),
      terminalTasks: new Set(),
      gapped: false,
      seqGap: null,
    });
    conn.boardId = parsed.boardId;
    conn.label = parsed.label ?? null;
    conn.capabilities = parsed.capabilities;
    conn.generation = generation;
    conn.credentialId = check.credentialId;
    conn.connectedAt = this.now();
    this.boards.set(parsed.boardId, conn);
    if (previous) this.fanoutTasks(parsed.boardId, this.gap(parsed.boardId, generation, 1, 0, "generation_changed"));
    this.log("info", "board registered", { boardId: parsed.boardId, generation });
    this.deliver(conn.send, makeAck(this.now(), parsed.envelope.id, {
      stage: "executed",
      boardId: parsed.boardId,
      generation,
    }));
  }

  private listBoards(conn: PhoneConn, requestId: string): void {
    const boards: JsonObject[] = [];
    for (const boardId of conn.boardIds) {
      const live = this.boards.get(boardId);
      const state = this.runtime.get(boardId);
      if (!live && !state) {
        boards.push({ boardId, online: false });
        continue;
      }
      const entry: JsonObject = { boardId, online: Boolean(live), generation: state?.generation ?? 0 };
      if (live?.label) entry.label = live.label;
      if (live) entry.capabilities = live.capabilities;
      if (live?.connectedAt !== null && live?.connectedAt !== undefined) entry.connectedAt = live.connectedAt;
      boards.push(entry);
    }
    this.deliver(conn.send, makeAck(this.now(), requestId, { stage: "executed", boards }));
  }

  private subscribeTasks(conn: PhoneConn, boardId: string, requestId: string, afterSeq?: number): void {
    if (!this.allow(conn, boardId, requestId)) return;
    conn.taskBoards.add(boardId);
    const state = this.runtime.get(boardId);
    this.deliver(conn.send, makeAck(this.now(), requestId, {
      stage: "executed",
      boardId,
      generation: state?.generation ?? 0,
      ...(state?.snapshot?.payload?.version !== undefined ? { snapshotVersion: state.snapshot.payload.version } : {}),
    }));
    this.replay(conn, boardId, afterSeq);
  }

  private subscribeLogs(conn: PhoneConn, boardId: string, taskId: string | undefined, requestId: string): void {
    if (!this.allow(conn, boardId, requestId)) return;
    conn.logBoards.set(boardId, taskId ? new Set([taskId]) : null);
    const extra: JsonObject = { stage: "executed", boardId };
    if (taskId) extra.taskId = taskId;
    this.deliver(conn.send, makeAck(this.now(), requestId, extra));
    this.replayLogs(conn, boardId, taskId);
  }

  private lookup(conn: PhoneConn, parsed: Extract<Incoming, { kind: "cmd.lookup" }>): void {
    if (!this.allow(conn, parsed.boardId, parsed.envelope.id)) return;
    const record = this.liveCommand(parsed.cmd, parsed.boardId, parsed.idempotencyKey);
    if (!record) {
      this.deliver(conn.send, makeAck(this.now(), parsed.envelope.id, {
        stage: "unknown",
        boardId: parsed.boardId,
        idempotencyKey: parsed.idempotencyKey,
      }));
      return;
    }
    this.deliver(conn.send, this.recordMessage(record, parsed.envelope.id, true));
  }

  private forwardCmd(
    conn: PhoneConn,
    parsed: Extract<Incoming, { kind: "cmd.create" | "cmd.continue" | "cmd.stop" | "cmd.workspace.create" | "cmd.workspace.delete" | "cmd.detail" | "cmd.archive.list" }>,
  ): void {
    if (!this.allow(conn, parsed.boardId, parsed.envelope.id)) return;
    const key = this.commandKey(parsed.kind, parsed.boardId, parsed.idempotencyKey);
    const existing = this.liveCommand(parsed.kind, parsed.boardId, parsed.idempotencyKey);
    if (existing) {
      if (existing.stage === "accepted" && existing.waiters.length < 20) {
        existing.waiters.push({ phone: conn, requestId: parsed.envelope.id });
      }
      this.deliver(conn.send, this.recordMessage(existing, parsed.envelope.id, true));
      return;
    }
    const board = this.boards.get(parsed.boardId);
    if (!board) {
      this.deliver(conn.send, makeErr(this.now(), `board ${parsed.boardId} is not connected`, {
        code: "board_offline",
        ref: parsed.envelope.id,
        stage: "failed",
        idempotencyKey: parsed.idempotencyKey,
      }));
      return;
    }
    if (parsed.kind === "cmd.archive.list" && !board.capabilities.includes(ARCHIVE_CAPABILITY)) {
      this.deliver(conn.send, makeErr(this.now(), "archive list is not available", {
        code: "unsupported",
        ref: parsed.envelope.id,
        stage: "failed",
        idempotencyKey: parsed.idempotencyKey,
      }));
      return;
    }
    const commandId = randomUUID();
    const record: CommandRecord = {
      commandId,
      idempotencyKey: parsed.idempotencyKey,
      boardId: parsed.boardId,
      boardConnId: board.id,
      generation: board.generation,
      type: parsed.kind,
      stage: "accepted",
      expiresAt: this.now() + (this.opts.idempotencyTtlMs ?? 600_000),
      waiters: [{ phone: conn, requestId: parsed.envelope.id }],
    };
    this.commands.set(key, record);
    this.commandByRelayId.set(commandId, key);
    this.deliver(conn.send, this.recordMessage(record, parsed.envelope.id, false));
    const timer = setTimeout(() => {
      if (record.stage !== "accepted") return;
      this.finishCommand(record, {
        stage: "timeout",
        errorCode: "timeout",
        errorMessage: "board did not acknowledge the command",
      });
    }, this.opts.cmdTimeoutMs);
    timer.unref?.();
    record.timer = timer;
    this.deliver(board.send, {
      v: 1,
      id: commandId,
      type: parsed.envelope.type,
      ts: parsed.envelope.ts,
      payload: parsed.envelope.payload,
    });
  }

  private resolveCommand(
    conn: BoardConn,
    ref: string,
    result: { type: "ack"; envelope: Envelope } | { type: "err"; code: string; message: string },
  ): void {
    const key = this.commandByRelayId.get(ref);
    const record = key ? this.commands.get(key) : undefined;
    if (!record || record.stage !== "accepted") {
      this.log("warn", "orphan board response", { ref });
      return;
    }
    const owns =
      record.boardConnId === conn.id &&
      record.boardId === conn.boardId &&
      record.generation === conn.generation &&
      this.boards.get(record.boardId) === conn;
    if (!owns) {
      this.deliver(conn.send, makeErr(this.now(), "command belongs to another board connection", {
        code: "forbidden",
        ref,
        stage: "failed",
      }));
      return;
    }
    if (result.type === "ack") {
      const task = result.envelope.payload?.task;
      const archive = result.envelope.payload?.archive;
      const workspace = result.envelope.payload?.workspace;
      const deleted = result.envelope.payload?.deleted;
      this.finishCommand(record, {
        stage: "executed",
        ...(isJsonObject(task) ? { task } : {}),
        ...(isJsonObject(archive) ? { archive } : {}),
        ...(isJsonObject(workspace) ? { workspace } : {}),
        ...(typeof deleted === "string" ? { deleted } : {}),
      });
      return;
    }
    this.finishCommand(record, { stage: "failed", errorCode: result.code, errorMessage: result.message });
  }

  private finishCommand(
    record: CommandRecord,
    update:
      | { stage: "executed"; task?: JsonObject; archive?: JsonObject; workspace?: JsonObject; deleted?: string }
      | { stage: "failed" | "timeout"; errorCode: string; errorMessage: string },
  ): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.stage = update.stage;
    record.expiresAt = this.now() + (this.opts.idempotencyTtlMs ?? 600_000);
    if (update.stage === "executed") {
      if (update.task) record.task = update.task;
      if (update.archive) record.archive = update.archive;
      if (update.workspace) record.workspace = update.workspace;
      if (update.deleted) record.deleted = update.deleted;
    } else {
      record.errorCode = update.errorCode;
      record.errorMessage = update.errorMessage;
    }
    const waiters = record.waiters.splice(0);
    for (const waiter of waiters) {
      if (!this.sessionStillValid(waiter.phone)) continue;
      this.deliver(waiter.phone.send, this.recordMessage(record, waiter.requestId, false));
    }
  }

  private publish(
    conn: BoardConn,
    parsed: Extract<Incoming, { kind: "evt.task" | "evt.log" | "evt.snapshot" | "evt.task.done" }>,
  ): void {
    if (parsed.boardId !== conn.boardId || parsed.generation !== conn.generation) {
      this.deliver(conn.send, makeErr(this.now(), "event generation does not match this connection", {
        code: "generation_mismatch",
        ref: parsed.envelope.id,
        stage: "failed",
      }));
      return;
    }
    const state = this.runtime.get(parsed.boardId);
    if (!state) return;
    if (state.seenEventIds.has(parsed.eventId)) return;
    if (parsed.seq !== state.lastSeq + 1) {
      this.deliver(conn.send, makeErr(this.now(), `expected seq ${state.lastSeq + 1}`, {
        code: "seq_gap",
        ref: parsed.envelope.id,
        stage: "failed",
      }));
      state.seqGap = { expectedSeq: state.lastSeq + 1, gotSeq: parsed.seq };
      this.fanoutTasks(parsed.boardId, this.gap(parsed.boardId, state.generation, state.lastSeq + 1, parsed.seq, "seq_gap"));
      return;
    }
    state.lastSeq = parsed.seq;
    state.seqGap = null;
    state.seenEventIds.add(parsed.eventId);

    if (parsed.kind === "evt.task.done" && state.terminalTasks.has(parsed.taskId)) return;
    if (parsed.kind === "evt.snapshot") {
      state.snapshot = parsed.envelope;
      state.incremental = [];
      state.gapped = false;
    } else if (parsed.kind === "evt.task.done") {
      state.terminalTasks.add(parsed.taskId);
      this.fanoutDone(parsed.boardId, parsed.envelope);
      return;
    } else if (parsed.kind === "evt.log") {
      this.pushRing(state.logs, parsed.envelope);
      this.fanoutLogs(parsed.boardId, parsed.taskId, parsed.envelope);
      return;
    } else if (this.pushRing(state.incremental, parsed.envelope)) {
      state.gapped = true;
    }

    this.fanoutTasks(parsed.boardId, parsed.envelope);
  }

  private replay(conn: PhoneConn, boardId: string, afterSeq?: number): void {
    const state = this.runtime.get(boardId);
    if (!state?.snapshot) {
      if (state?.seqGap) {
        this.deliver(conn.send, this.gap(boardId, state.generation, state.seqGap.expectedSeq, state.seqGap.gotSeq, "seq_gap"));
      } else if (afterSeq !== undefined) {
        this.deliver(conn.send, this.gap(boardId, state?.generation ?? 0, (afterSeq ?? 0) + 1, undefined, "no_snapshot"));
      }
      return;
    }
    if (afterSeq !== undefined && afterSeq > state.lastSeq) {
      this.deliver(conn.send, this.gap(boardId, state.generation, state.lastSeq, afterSeq, "ahead"));
    }
    if (state.seqGap) {
      this.deliver(conn.send, this.gap(boardId, state.generation, state.seqGap.expectedSeq, state.seqGap.gotSeq, "seq_gap"));
    } else if (state.gapped) {
      this.deliver(conn.send, this.gap(boardId, state.generation, state.lastSeq, undefined, "buffer_gap"));
    }
    if (!this.sessionStillValid(conn)) return;
    this.deliver(conn.send, state.snapshot);
    for (const event of state.incremental) {
      if (event.type !== "evt.task") continue;
      const seq = typeof event.payload?.seq === "number" ? event.payload.seq : 0;
      if (afterSeq !== undefined && seq <= afterSeq) continue;
      this.deliver(conn.send, event);
    }
  }

  private replayLogs(conn: PhoneConn, boardId: string, taskId?: string): void {
    const state = this.runtime.get(boardId);
    if (!state || !this.sessionStillValid(conn)) return;
    for (const event of state.logs) {
      if (event.type !== "evt.log") continue;
      if (taskId && event.payload?.taskId !== taskId) continue;
      this.deliver(conn.send, event);
    }
  }

  private pushRing(ring: Envelope[], event: Envelope): boolean {
    ring.push(event);
    if (ring.length <= 200) return false;
    ring.shift();
    return true;
  }

  private fanoutTasks(boardId: string, event: Envelope): void {
    for (const phone of [...this.phones]) {
      if (!this.sessionStillValid(phone) || !phone.taskBoards.has(boardId)) continue;
      if (!phone.boardIds.includes(boardId)) continue;
      this.deliver(phone.send, event);
    }
  }

  private fanoutLogs(boardId: string, taskId: string, event: Envelope): void {
    for (const phone of [...this.phones]) {
      if (!this.sessionStillValid(phone) || !phone.boardIds.includes(boardId)) continue;
      const filter = phone.logBoards.get(boardId);
      if (filter === undefined) continue;
      if (filter !== null && !filter.has(taskId)) continue;
      this.deliver(phone.send, event);
    }
  }

  private fanoutDone(boardId: string, event: Envelope): void {
    const eventId = typeof event.payload?.eventId === "string" ? event.payload.eventId : "";
    let delivered = 0;
    for (const phone of [...this.phones]) {
      if (!this.sessionStillValid(phone) || !phone.boardIds.includes(boardId)) continue;
      if (eventId && phone.seenEventIds.has(eventId)) continue;
      if (eventId) phone.seenEventIds.add(eventId);
      this.deliver(phone.send, event);
      delivered += 1;
    }
    if (delivered === 0) {
      this.log("info", "dropped evt.task.done; no authorized phone online", { boardId, eventId });
    }
  }

  private releaseBoard(conn: BoardConn, code: string, message: string): void {
    if (!conn.boardId) return;
    const boardId = conn.boardId;
    if (this.boards.get(boardId) === conn) {
      this.boards.delete(boardId);
      this.failBoardCommands(boardId, code, message);
    }
    conn.boardId = null;
    conn.generation = 0;
  }

  private dropPhone(phone: PhoneConn, message: string): void {
    if (phone.closed) return;
    this.deliver(phone.send, makeErr(this.now(), message, { code: "revoked", stage: "failed" }));
    this.disconnectPhone(phone);
    phone.closeSocket();
  }

  /** Re-read the device token. An expired, revoked, or rotated token closes the socket. */
  private sessionStillValid(phone: PhoneConn): boolean {
    if (phone.closed || !phone.token) return false;
    const session = this.auth.verifyDevice(phone.token);
    if (!session || session.role !== "phone") {
      this.dropPhone(phone, "device token is no longer valid");
      return false;
    }
    phone.deviceId = session.deviceId;
    phone.boardIds = [...session.boardIds];
    return true;
  }

  private failBoardCommands(boardId: string, code: string, message: string): void {
    for (const record of this.commands.values()) {
      if (record.boardId !== boardId || record.stage !== "accepted") continue;
      this.finishCommand(record, { stage: "failed", errorCode: code, errorMessage: message });
    }
  }

  private noteKick(boardId: string): void {
    this.log("info", "board credential revoked", { boardId });
  }

  private allow(conn: PhoneConn, boardId: string, requestId: string): boolean {
    if (!conn.boardIds.includes(boardId)) {
      this.deliver(conn.send, makeErr(this.now(), "boardId is not allowed for this device", {
        code: "forbidden",
        ref: requestId,
        stage: "failed",
      }));
      return false;
    }
    return true;
  }

  private sessionLive(conn: PhoneConn, requestId: string): boolean {
    if (!conn.deviceId || !conn.token) {
      this.deliver(conn.send, makeErr(this.now(), "send client.hello first", { code: "unauthorized", ref: requestId, stage: "failed" }));
      return false;
    }
    if (this.sessionStillValid(conn)) return true;
    return false;
  }

  private liveCommand(type: CommandType, boardId: string, idempotencyKey: string): CommandRecord | undefined {
    const key = this.commandKey(type, boardId, idempotencyKey);
    const record = this.commands.get(key);
    if (!record) return undefined;
    if (record.stage !== "accepted" && record.expiresAt <= this.now()) {
      if (record.timer) clearTimeout(record.timer);
      this.commands.delete(key);
      this.commandByRelayId.delete(record.commandId);
      return undefined;
    }
    return record;
  }

  private commandKey(type: string, boardId: string, idempotencyKey: string): string {
    return `${type}\0${boardId}\0${idempotencyKey}`;
  }

  private recordMessage(record: CommandRecord, requestId: string, duplicate: boolean): Envelope {
    const base: JsonObject = {
      stage: record.stage,
      idempotencyKey: record.idempotencyKey,
      commandId: record.commandId,
      boardId: record.boardId,
    };
    if (duplicate) base.duplicate = true;
    if (record.task) base.task = record.task;
    if (record.archive) base.archive = record.archive;
    if (record.workspace) base.workspace = record.workspace;
    if (record.deleted) base.deleted = record.deleted;
    if (record.errorCode) base.code = record.errorCode;
    if (record.errorMessage) base.message = record.errorMessage;
    return makeAck(this.now(), requestId, base);
  }

  private gap(boardId: string, generation: number, expectedSeq: number, gotSeq: number | undefined, reason: string): Envelope {
    const payload: JsonObject = { boardId, generation, expectedSeq, reason };
    if (gotSeq !== undefined) payload.gotSeq = gotSeq;
    return { v: 1, id: randomUUID(), type: "evt.gap", ts: this.now(), payload };
  }

  private deliver(send: (message: Envelope) => void, message: Envelope): void {
    try {
      send(message);
    } catch {
      // The socket is already gone.
    }
  }

  private log(level: "info" | "warn" | "error", message: string, fields?: LogFields): void {
    this.opts.log?.(level, message, fields);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
