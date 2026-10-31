import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;

export const TASK_STATUSES = ["queued", "running", "paused", "succeeded", "failed", "stopped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES = ["succeeded", "failed", "stopped"] as const;
export type TerminalStatus = (typeof TERMINAL_TASK_STATUSES)[number];

export const LOG_STREAMS = ["stdout", "stderr", "system"] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const CMD_TYPES = ["cmd.create", "cmd.continue", "cmd.stop"] as const;
export type CommandType = (typeof CMD_TYPES)[number];

export const ACK_STAGES = ["accepted", "executed", "failed", "timeout", "unknown"] as const;
export type AckStage = (typeof ACK_STAGES)[number];

export const GAP_REASONS = ["seq_gap", "buffer_gap", "generation_changed", "ahead", "no_snapshot"] as const;
export type GapReason = (typeof GAP_REASONS)[number];

const MESSAGE_KINDS = [
  "board.register",
  "client.hello",
  "board.list",
  "sub.tasks",
  "sub.logs",
  "cmd.create",
  "cmd.continue",
  "cmd.stop",
  "cmd.lookup",
  "evt.task",
  "evt.log",
  "evt.snapshot",
  "evt.task.done",
  "evt.gap",
  "ack",
  "err",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];
const KIND_SET = new Set<string>(MESSAGE_KINDS);

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type Envelope = {
  v: 1;
  id: string;
  type: string;
  ts: number;
  payload?: JsonObject;
};

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  updatedAt: number;
  agent?: string;
};

export type ParseFailure = {
  ok: false;
  code: "bad_request" | "bad_version" | "bad_type";
  message: string;
  id?: string;
};

type Cursor = { boardId: string; generation: number; seq: number; eventId: string };

export type Incoming =
  | { ok: true; kind: "board.register"; envelope: Envelope; boardId: string; token: string; label?: string }
  | { ok: true; kind: "client.hello"; envelope: Envelope; token: string; name?: string }
  | { ok: true; kind: "board.list"; envelope: Envelope }
  | { ok: true; kind: "sub.tasks"; envelope: Envelope; boardId: string; afterSeq?: number }
  | { ok: true; kind: "sub.logs"; envelope: Envelope; boardId: string; taskId?: string }
  | { ok: true; kind: "cmd.create"; envelope: Envelope; boardId: string; idempotencyKey: string }
  | { ok: true; kind: "cmd.continue"; envelope: Envelope; boardId: string; idempotencyKey: string; taskId: string }
  | { ok: true; kind: "cmd.stop"; envelope: Envelope; boardId: string; idempotencyKey: string; taskId: string }
  | { ok: true; kind: "cmd.lookup"; envelope: Envelope; boardId: string; idempotencyKey: string; cmd: CommandType }
  | ({ ok: true; kind: "evt.task"; envelope: Envelope } & Cursor)
  | ({ ok: true; kind: "evt.log"; envelope: Envelope; taskId: string } & Cursor)
  | ({ ok: true; kind: "evt.snapshot"; envelope: Envelope; version: number } & Cursor)
  | ({ ok: true; kind: "evt.task.done"; envelope: Envelope; taskId: string; status: TerminalStatus } & Cursor)
  | { ok: true; kind: "evt.gap"; envelope: Envelope; boardId: string }
  | { ok: true; kind: "ack"; envelope: Envelope; ref: string }
  | { ok: true; kind: "err"; envelope: Envelope; ref: string; code: string; errMessage: string }
  | ParseFailure;

const MSG_ID = /^[\x21-\x7e]{1,100}$/;
const KEY_ID = /^[\x21-\x7e]{8,80}$/;
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ERR_CODE = /^[a-z0-9_]{1,64}$/;

export function parseMessage(raw: unknown): Incoming {
  const decoded = decode(raw);
  if (!decoded.ok) return decoded.failure;
  const { value } = decoded;
  const earlyId = typeof value.id === "string" && MSG_ID.test(value.id) ? value.id : undefined;
  if (value.v !== PROTOCOL_VERSION) return failure("bad_version", "unsupported protocol version", earlyId);
  if (!earlyId) return failure("bad_request", "id must be 1-100 visible ASCII characters");
  const id = earlyId;
  if (typeof value.type !== "string" || !value.type) return failure("bad_type", "type is required", id);
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) {
    return failure("bad_request", "ts must be a finite number", id);
  }
  if (!KIND_SET.has(value.type)) return failure("bad_type", `unknown type ${value.type}`, id);
  const kind = value.type as MessageKind;
  const ts = value.ts;
  const payload = value.payload;

  switch (kind) {
    case "board.list":
      return parseBoardList(payload, id, ts);
    case "board.register":
      return parseRegister(payload, id, ts);
    case "client.hello":
      return parseHello(payload, id, ts);
    case "sub.tasks":
      return parseSubTasks(payload, id, ts);
    case "sub.logs":
      return parseSubLogs(payload, id, ts);
    case "cmd.create":
      return parseCmdCreate(payload, id, ts);
    case "cmd.continue":
      return parseCmdTask(payload, id, ts, "cmd.continue");
    case "cmd.stop":
      return parseCmdStop(payload, id, ts);
    case "cmd.lookup":
      return parseLookup(payload, id, ts);
    case "evt.task":
      return parseEvtTask(payload, id, ts);
    case "evt.log":
      return parseEvtLog(payload, id, ts);
    case "evt.snapshot":
      return parseEvtSnapshot(payload, id, ts);
    case "evt.task.done":
      return parseEvtTaskDone(payload, id, ts);
    case "evt.gap":
      return parseGap(payload, id, ts);
    case "ack":
      return parseAck(payload, id, ts);
    case "err":
      return parseErr(payload, id, ts);
    default:
      return failure("bad_type", `unknown type ${kind}`, id);
  }
}

export function makeAck(now: number, ref: string, extra?: JsonObject): Envelope {
  return { v: 1, id: randomUUID(), type: "ack", ts: now, payload: { ref, ...extra } };
}

export function makeErr(
  now: number,
  message: string,
  opts: { code: string; ref?: string; stage?: AckStage; idempotencyKey?: string; commandId?: string },
): Envelope {
  const payload: JsonObject = { code: opts.code, message };
  if (opts.ref) payload.ref = opts.ref;
  if (opts.stage) payload.stage = opts.stage;
  if (opts.idempotencyKey) payload.idempotencyKey = opts.idempotencyKey;
  if (opts.commandId) payload.commandId = opts.commandId;
  return { v: 1, id: randomUUID(), type: "err", ts: now, payload };
}

export function isTerminalStatus(status: string): status is TerminalStatus {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

function parseBoardList(payload: unknown, id: string, ts: number): Incoming {
  if (payload !== undefined && !isRecord(payload)) return failure("bad_request", "payload must be an object", id);
  return { ok: true, kind: "board.list", envelope: envelope("board.list", id, ts) };
}

function parseRegister(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const token = readText(record.value.token, "token", 1, 512);
  if (!token.ok) return failure("bad_request", token.message, id);
  const label = optionalText(record.value, "label", 1, 80);
  if (!label.ok) return failure("bad_request", label.message, id);
  const body: JsonObject = { boardId: boardId.value, token: token.value };
  if (label.value) body.label = label.value;
  return {
    ok: true,
    kind: "board.register",
    envelope: envelope("board.register", id, ts, body),
    boardId: boardId.value,
    token: token.value,
    ...(label.value ? { label: label.value } : {}),
  };
}

function parseHello(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const token = readText(record.value.token, "token", 1, 512);
  if (!token.ok) return failure("bad_request", token.message, id);
  const name = optionalText(record.value, "name", 1, 80);
  if (!name.ok) return failure("bad_request", name.message, id);
  const body: JsonObject = { token: token.value };
  if (name.value) body.name = name.value;
  return {
    ok: true,
    kind: "client.hello",
    envelope: envelope("client.hello", id, ts, body),
    token: token.value,
    ...(name.value ? { name: name.value } : {}),
  };
}

function parseSubTasks(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const after = optionalInt(record.value, "afterSeq", 0);
  if (!after.ok) return failure("bad_request", after.message, id);
  const body: JsonObject = { boardId: boardId.value };
  if (after.value !== undefined) body.afterSeq = after.value;
  return {
    ok: true,
    kind: "sub.tasks",
    envelope: envelope("sub.tasks", id, ts, body),
    boardId: boardId.value,
    ...(after.value !== undefined ? { afterSeq: after.value } : {}),
  };
}

function parseSubLogs(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  let taskId: string | undefined;
  if (record.value.taskId !== undefined) {
    const parsed = readBoardId(record.value.taskId, "taskId");
    if (!parsed.ok) return failure("bad_request", parsed.message, id);
    taskId = parsed.value;
  }
  const body: JsonObject = { boardId: boardId.value };
  if (taskId) body.taskId = taskId;
  return {
    ok: true,
    kind: "sub.logs",
    envelope: envelope("sub.logs", id, ts, body),
    boardId: boardId.value,
    ...(taskId ? { taskId } : {}),
  };
}

function parseCmdCreate(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const key = readKey(record.value.idempotencyKey);
  if (!key.ok) return failure("bad_request", key.message, id);
  const title = readText(record.value.title, "title", 1, 200);
  if (!title.ok) return failure("bad_request", title.message, id);
  const prompt = readText(record.value.prompt, "prompt", 1, 20_000);
  if (!prompt.ok) return failure("bad_request", prompt.message, id);
  const body: JsonObject = {
    boardId: boardId.value,
    idempotencyKey: key.value,
    title: title.value,
    prompt: prompt.value,
  };
  const agent = optionalText(record.value, "agent", 1, 64);
  if (!agent.ok) return failure("bad_request", agent.message, id);
  if (agent.value) body.agent = agent.value;
  const cwd = optionalText(record.value, "cwd", 1, 1024);
  if (!cwd.ok) return failure("bad_request", cwd.message, id);
  if (cwd.value) body.cwd = cwd.value;
  const worktree = readOptionalBoolean(record.value, "useGitWorktree");
  if (!worktree.ok) return failure("bad_request", worktree.message, id);
  if (worktree.value === true) body.useGitWorktree = true;
  return {
    ok: true,
    kind: "cmd.create",
    envelope: envelope("cmd.create", id, ts, body),
    boardId: boardId.value,
    idempotencyKey: key.value,
  };
}

function parseCmdTask(payload: unknown, id: string, ts: number, kind: "cmd.continue"): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const common = readCmdTarget(record.value, id);
  if (!common.ok) return common.failure;
  return {
    ok: true,
    kind,
    envelope: envelope(kind, id, ts, common.body),
    boardId: common.boardId,
    idempotencyKey: common.idempotencyKey,
    taskId: common.taskId,
  };
}

function parseCmdStop(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const common = readCmdTarget(record.value, id);
  if (!common.ok) return common.failure;
  const body: JsonObject = { ...common.body };
  const reason = optionalText(record.value, "reason", 1, 500);
  if (!reason.ok) return failure("bad_request", reason.message, id);
  if (reason.value) body.reason = reason.value;
  return {
    ok: true,
    kind: "cmd.stop",
    envelope: envelope("cmd.stop", id, ts, body),
    boardId: common.boardId,
    idempotencyKey: common.idempotencyKey,
    taskId: common.taskId,
  };
}

function parseLookup(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const key = readKey(record.value.idempotencyKey);
  if (!key.ok) return failure("bad_request", key.message, id);
  if (typeof record.value.cmd !== "string" || !isCommandType(record.value.cmd)) {
    return failure("bad_request", "cmd must be cmd.create, cmd.continue, or cmd.stop", id);
  }
  return {
    ok: true,
    kind: "cmd.lookup",
    envelope: envelope("cmd.lookup", id, ts, { boardId: boardId.value, idempotencyKey: key.value, cmd: record.value.cmd }),
    boardId: boardId.value,
    idempotencyKey: key.value,
    cmd: record.value.cmd,
  };
}

function parseEvtTask(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const cursor = readCursor(record.value, id);
  if (!cursor.ok) return cursor.failure;
  const task = readTask(record.value.task, false);
  if (!task.ok) return failure("bad_request", task.message, id);
  return {
    ok: true,
    kind: "evt.task",
    envelope: envelope("evt.task", id, ts, { ...cursor.body, task: taskToJson(task.task) }),
    ...cursor.cursor,
  };
}

function parseEvtLog(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const cursor = readCursor(record.value, id);
  if (!cursor.ok) return cursor.failure;
  const taskId = readBoardId(record.value.taskId, "taskId");
  if (!taskId.ok) return failure("bad_request", taskId.message, id);
  if (typeof record.value.stream !== "string" || !isLogStream(record.value.stream)) {
    return failure("bad_request", "stream must be stdout, stderr, or system", id);
  }
  const line = readText(record.value.line, "line", 1, 8_000);
  if (!line.ok) return failure("bad_request", line.message, id);
  return {
    ok: true,
    kind: "evt.log",
    envelope: envelope("evt.log", id, ts, {
      ...cursor.body,
      taskId: taskId.value,
      stream: record.value.stream,
      line: line.value,
    }),
    ...cursor.cursor,
    taskId: taskId.value,
  };
}

function parseEvtSnapshot(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const cursor = readCursor(record.value, id);
  if (!cursor.ok) return cursor.failure;
  if (record.value.version !== cursor.cursor.seq) {
    return failure("bad_request", "version must equal seq", id);
  }
  if (typeof record.value.capturedAt !== "number" || !Number.isFinite(record.value.capturedAt)) {
    return failure("bad_request", "capturedAt must be a finite number", id);
  }
  if (!Array.isArray(record.value.tasks)) return failure("bad_request", "tasks must be an array", id);
  if (record.value.tasks.length > 200) return failure("bad_request", "tasks exceeds 200 items", id);
  const tasks: Json[] = [];
  for (const item of record.value.tasks) {
    const task = readTask(item, false);
    if (!task.ok) return failure("bad_request", task.message, id);
    tasks.push(taskToJson(task.task));
  }
  const workspaces = readSnapshotWorkspaces(record.value.workspaces);
  if (!workspaces.ok) return failure("bad_request", workspaces.message, id);
  const snapshotBody: JsonObject = {
    ...cursor.body,
    version: cursor.cursor.seq,
    capturedAt: record.value.capturedAt,
    tasks,
  };
  if (workspaces.value) snapshotBody.workspaces = workspaces.value;
  return {
    ok: true,
    kind: "evt.snapshot",
    envelope: envelope("evt.snapshot", id, ts, snapshotBody),
    ...cursor.cursor,
    version: cursor.cursor.seq,
  };
}

function parseEvtTaskDone(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const cursor = readCursor(record.value, id);
  if (!cursor.ok) return cursor.failure;
  const taskId = readBoardId(record.value.taskId, "taskId");
  if (!taskId.ok) return failure("bad_request", taskId.message, id);
  if (typeof record.value.status !== "string" || !isTerminalStatus(record.value.status)) {
    return failure("bad_request", "evt.task.done requires status succeeded, failed, or stopped", id);
  }
  const body: JsonObject = { ...cursor.body, taskId: taskId.value, status: record.value.status };
  const title = optionalText(record.value, "title", 1, 200);
  if (!title.ok) return failure("bad_request", title.message, id);
  if (title.value) body.title = title.value;
  const summary = optionalText(record.value, "summary", 1, 500);
  if (!summary.ok) return failure("bad_request", summary.message, id);
  if (summary.value) body.summary = summary.value;
  return {
    ok: true,
    kind: "evt.task.done",
    envelope: envelope("evt.task.done", id, ts, body),
    ...cursor.cursor,
    taskId: taskId.value,
    status: record.value.status,
  };
}

function parseGap(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const generation = readInt(record.value.generation, "generation", 1);
  if (!generation.ok) return failure("bad_request", generation.message, id);
  const expectedSeq = readInt(record.value.expectedSeq, "expectedSeq", 0);
  if (!expectedSeq.ok) return failure("bad_request", expectedSeq.message, id);
  const got = optionalInt(record.value, "gotSeq", 0);
  if (!got.ok) return failure("bad_request", got.message, id);
  if (typeof record.value.reason !== "string" || !isGapReason(record.value.reason)) {
    return failure("bad_request", "reason is invalid", id);
  }
  const body: JsonObject = {
    boardId: boardId.value,
    generation: generation.value,
    expectedSeq: expectedSeq.value,
    reason: record.value.reason,
  };
  if (got.value !== undefined) body.gotSeq = got.value;
  return { ok: true, kind: "evt.gap", envelope: envelope("evt.gap", id, ts, body), boardId: boardId.value };
}

function parseAck(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const ref = typeof record.value.ref === "string" ? readMessageId(record.value.ref) : { ok: false as const, message: "ref is required" };
  if (!ref.ok) return failure("bad_request", `payload.ref: ${ref.message}`, id);
  const body: JsonObject = { ref: ref.value };
  if (record.value.stage !== undefined) {
    if (typeof record.value.stage !== "string" || !isAckStage(record.value.stage)) {
      return failure("bad_request", "stage is invalid", id);
    }
    body.stage = record.value.stage;
  }
  if (record.value.task !== undefined) {
    const task = readTask(record.value.task, false);
    if (!task.ok) return failure("bad_request", task.message, id);
    body.task = taskToJson(task.task);
  }
  if (record.value.boards !== undefined) {
    const boards = readBoards(record.value.boards);
    if (!boards.ok) return failure("bad_request", boards.message, id);
    body.boards = boards.value;
  }
  const key = optionalKey(record.value, "idempotencyKey");
  if (!key.ok) return failure("bad_request", key.message, id);
  if (key.value) body.idempotencyKey = key.value;
  const commandId = optionalMessageId(record.value, "commandId");
  if (!commandId.ok) return failure("bad_request", commandId.message, id);
  if (commandId.value) body.commandId = commandId.value;
  const boardId = optionalBoardId(record.value, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  if (boardId.value) body.boardId = boardId.value;
  const generation = optionalInt(record.value, "generation", 1);
  if (!generation.ok) return failure("bad_request", generation.message, id);
  if (generation.value !== undefined) body.generation = generation.value;
  if (record.value.duplicate !== undefined) {
    if (typeof record.value.duplicate !== "boolean") return failure("bad_request", "duplicate must be a boolean", id);
    body.duplicate = record.value.duplicate;
  }
  const deviceId = optionalText(record.value, "deviceId", 1, 80);
  if (!deviceId.ok) return failure("bad_request", deviceId.message, id);
  if (deviceId.value) body.deviceId = deviceId.value;
  if (record.value.role !== undefined) {
    if (record.value.role !== "phone") return failure("bad_request", "role is invalid", id);
    body.role = "phone";
  }
  if (record.value.code !== undefined) {
    if (typeof record.value.code !== "string" || !ERR_CODE.test(record.value.code)) {
      return failure("bad_request", "ack.code is invalid", id);
    }
    body.code = record.value.code;
  }
  const ackMessage = optionalText(record.value, "message", 1, 500);
  if (!ackMessage.ok) return failure("bad_request", ackMessage.message, id);
  if (ackMessage.value) body.message = ackMessage.value;
  if (record.value.boardIds !== undefined) {
    const ids = readBoardIdList(record.value.boardIds);
    if (!ids.ok) return failure("bad_request", ids.message, id);
    body.boardIds = ids.value;
  }
  return { ok: true, kind: "ack", envelope: envelope("ack", id, ts, body), ref: ref.value };
}

function parseErr(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const ref = typeof record.value.ref === "string" ? readMessageId(record.value.ref) : { ok: false as const, message: "ref is required" };
  if (!ref.ok) return failure("bad_request", `payload.ref: ${ref.message}`, id);
  if (typeof record.value.code !== "string" || !ERR_CODE.test(record.value.code)) {
    return failure("bad_request", "err.code must be 1-64 characters of a-z, 0-9, or _", id);
  }
  const message = readText(record.value.message, "message", 1, 500);
  if (!message.ok) return failure("bad_request", message.message, id);
  const body: JsonObject = { ref: ref.value, code: record.value.code, message: message.value };
  if (record.value.stage !== undefined) {
    if (typeof record.value.stage !== "string" || !isAckStage(record.value.stage)) {
      return failure("bad_request", "stage is invalid", id);
    }
    body.stage = record.value.stage;
  }
  const key = optionalKey(record.value, "idempotencyKey");
  if (!key.ok) return failure("bad_request", key.message, id);
  if (key.value) body.idempotencyKey = key.value;
  const commandId = optionalMessageId(record.value, "commandId");
  if (!commandId.ok) return failure("bad_request", commandId.message, id);
  if (commandId.value) body.commandId = commandId.value;
  return {
    ok: true,
    kind: "err",
    envelope: envelope("err", id, ts, body),
    ref: ref.value,
    code: record.value.code,
    errMessage: message.value,
  };
}

function readCmdTarget(
  record: Record<string, unknown>,
  id: string,
): { ok: true; boardId: string; idempotencyKey: string; taskId: string; body: JsonObject } | { ok: false; failure: ParseFailure } {
  const boardId = readBoardId(record.boardId, "boardId");
  if (!boardId.ok) return { ok: false, failure: failure("bad_request", boardId.message, id) };
  const key = readKey(record.idempotencyKey);
  if (!key.ok) return { ok: false, failure: failure("bad_request", key.message, id) };
  const taskId = readBoardId(record.taskId, "taskId");
  if (!taskId.ok) return { ok: false, failure: failure("bad_request", taskId.message, id) };
  return {
    ok: true,
    boardId: boardId.value,
    idempotencyKey: key.value,
    taskId: taskId.value,
    body: { boardId: boardId.value, idempotencyKey: key.value, taskId: taskId.value },
  };
}

function readCursor(
  record: Record<string, unknown>,
  id: string,
): { ok: true; cursor: Cursor; body: JsonObject } | { ok: false; failure: ParseFailure } {
  const boardId = readBoardId(record.boardId, "boardId");
  if (!boardId.ok) return { ok: false, failure: failure("bad_request", boardId.message, id) };
  const generation = readInt(record.generation, "generation", 1);
  if (!generation.ok) return { ok: false, failure: failure("bad_request", generation.message, id) };
  const seq = readInt(record.seq, "seq", 1);
  if (!seq.ok) return { ok: false, failure: failure("bad_request", seq.message, id) };
  const eventId = typeof record.eventId === "string" ? readMessageId(record.eventId) : { ok: false as const, message: "eventId is required" };
  if (!eventId.ok) return { ok: false, failure: failure("bad_request", eventId.message, id) };
  const cursor = { boardId: boardId.value, generation: generation.value, seq: seq.value, eventId: eventId.value };
  return {
    ok: true,
    cursor,
    body: { boardId: cursor.boardId, generation: cursor.generation, seq: cursor.seq, eventId: cursor.eventId },
  };
}

function readBoardIdList(value: unknown): { ok: true; value: Json[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length > 20) return { ok: false, message: "boardIds must be an array of up to 20 ids" };
  const ids: Json[] = [];
  for (const item of value) {
    const boardId = readBoardId(item, "boardIds");
    if (!boardId.ok) return boardId;
    ids.push(boardId.value);
  }
  return { ok: true, value: ids };
}

function readBoards(value: unknown): { ok: true; value: Json[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) return { ok: false, message: "boards must be an array" };
  if (value.length > 100) return { ok: false, message: "boards exceeds 100 items" };
  const boards: Json[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, message: "board entry must be an object" };
    const boardId = readBoardId(item.boardId, "boards.boardId");
    if (!boardId.ok) return boardId;
    if (typeof item.online !== "boolean") return { ok: false, message: "boards.online must be a boolean" };
    const entry: JsonObject = { boardId: boardId.value, online: item.online };
    if (item.label !== undefined) {
      const label = readText(item.label, "boards.label", 1, 80);
      if (!label.ok) return label;
      entry.label = label.value;
    }
    if (item.connectedAt !== undefined) {
      if (typeof item.connectedAt !== "number" || !Number.isFinite(item.connectedAt)) {
        return { ok: false, message: "boards.connectedAt must be a finite number" };
      }
      entry.connectedAt = item.connectedAt;
    }
    if (item.generation !== undefined) {
      const generation = readInt(item.generation, "boards.generation", 0);
      if (!generation.ok) return generation;
      entry.generation = generation.value;
    }
    boards.push(entry);
  }
  return { ok: true, value: boards };
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  field: string,
): { ok: true; value?: boolean } | { ok: false; message: string } {
  if (record[field] === undefined) return { ok: true };
  if (typeof record[field] !== "boolean") return { ok: false, message: `${field} must be a boolean` };
  return { ok: true, value: record[field] };
}

function readSnapshotWorkspaces(value: unknown): { ok: true; value?: Json[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, message: "workspaces must be an array" };
  if (value.length > 50) return { ok: false, message: "workspaces exceeds 50 items" };
  const rows: Json[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, message: "workspace must be an object" };
    const id = readBoardId(item.id, "workspaces.id");
    if (!id.ok) return { ok: false, message: id.message };
    const name = readText(item.name, "workspaces.name", 1, 80);
    if (!name.ok) return name;
    const path = readText(item.path, "workspaces.path", 1, 1024);
    if (!path.ok) return path;
    if (path.value.includes("://")) return { ok: false, message: "workspaces.path must be a local path" };
    if (typeof item.isGit !== "boolean") return { ok: false, message: "workspaces.isGit must be a boolean" };
    rows.push({ id: id.value, name: name.value, path: path.value, isGit: item.isGit });
  }
  return { ok: true, value: rows };
}

function readTask(value: unknown, terminalOnly: boolean): { ok: true; task: Task } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "task must be an object" };
  const id = readBoardId(value.id, "task.id");
  if (!id.ok) return id;
  const title = readText(value.title, "task.title", 1, 200);
  if (!title.ok) return title;
  if (typeof value.status !== "string" || !isTaskStatus(value.status)) return { ok: false, message: "task.status is invalid" };
  if (terminalOnly && !isTerminalStatus(value.status)) {
    return { ok: false, message: "evt.task.done requires status succeeded, failed, or stopped" };
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    return { ok: false, message: "task.updatedAt must be a finite number" };
  }
  const task: Task = { id: id.value, title: title.value, status: value.status, updatedAt: value.updatedAt };
  if (value.agent !== undefined) {
    const agent = readText(value.agent, "task.agent", 1, 64);
    if (!agent.ok) return agent;
    task.agent = agent.value;
  }
  return { ok: true, task };
}

function taskToJson(task: Task): JsonObject {
  const json: JsonObject = { id: task.id, title: task.title, status: task.status, updatedAt: task.updatedAt };
  if (task.agent) json.agent = task.agent;
  return json;
}

function envelope(type: string, id: string, ts: number, payload?: JsonObject): Envelope {
  const message: Envelope = { v: 1, id, type, ts };
  if (payload) message.payload = payload;
  return message;
}

function decode(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; failure: ParseFailure } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, failure: failure("bad_request", "invalid JSON") };
    }
  }
  if (!isRecord(value)) return { ok: false, failure: failure("bad_request", "message must be a JSON object") };
  return { ok: true, value };
}

function requireRecord(payload: unknown, id: string): { ok: true; value: Record<string, unknown> } | { ok: false; failure: ParseFailure } {
  if (!isRecord(payload)) return { ok: false, failure: failure("bad_request", "payload must be an object", id) };
  return { ok: true, value: payload };
}

function failure(code: ParseFailure["code"], message: string, id?: string): ParseFailure {
  const result: ParseFailure = { ok: false, code, message };
  if (id) result.id = id;
  return result;
}

function readMessageId(value: string): { ok: true; value: string } | { ok: false; message: string } {
  if (!MSG_ID.test(value)) return { ok: false, message: "id must be 1-100 visible ASCII characters" };
  return { ok: true, value };
}

function readKey(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    return { ok: false, message: "idempotencyKey must be 8-80 visible ASCII characters" };
  }
  return { ok: true, value };
}

function readBoardId(value: unknown, field: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !BOARD_ID.test(value)) {
    return { ok: false, message: `${field} must be 1-64 characters of letters, digits, '.', '_' or '-'` };
  }
  return { ok: true, value };
}

function readText(value: unknown, field: string, min: number, max: number): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !isReadable(value) || value.trim().length < min || value.length > max) {
    return { ok: false, message: `${field} must be ${min}-${max} characters` };
  }
  return { ok: true, value };
}

function optionalText(
  record: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (record[field] === undefined) return { ok: true };
  return readText(record[field], field, min, max);
}

function optionalKey(record: Record<string, unknown>, field: string): { ok: true; value?: string } | { ok: false; message: string } {
  if (record[field] === undefined) return { ok: true };
  const parsed = readKey(record[field]);
  if (!parsed.ok) return { ok: false, message: `${field}: ${parsed.message}` };
  return { ok: true, value: parsed.value };
}

function optionalMessageId(record: Record<string, unknown>, field: string): { ok: true; value?: string } | { ok: false; message: string } {
  if (record[field] === undefined) return { ok: true };
  if (typeof record[field] !== "string") return { ok: false, message: `${field} is invalid` };
  const parsed = readMessageId(record[field] as string);
  if (!parsed.ok) return { ok: false, message: `${field}: ${parsed.message}` };
  return parsed;
}

function optionalBoardId(record: Record<string, unknown>, field: string): { ok: true; value?: string } | { ok: false; message: string } {
  if (record[field] === undefined) return { ok: true };
  return readBoardId(record[field], field);
}

function readInt(value: unknown, field: string, min: number): { ok: true; value: number } | { ok: false; message: string } {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    return { ok: false, message: `${field} must be an integer >= ${min}` };
  }
  return { ok: true, value: value as number };
}

function optionalInt(
  record: Record<string, unknown>,
  field: string,
  min: number,
): { ok: true; value?: number } | { ok: false; message: string } {
  if (record[field] === undefined) return { ok: true };
  return readInt(record[field], field, min);
}

function isReadable(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

function isLogStream(value: string): value is LogStream {
  return (LOG_STREAMS as readonly string[]).includes(value);
}

function isCommandType(value: string): value is CommandType {
  return (CMD_TYPES as readonly string[]).includes(value);
}

function isAckStage(value: string): value is AckStage {
  return (ACK_STAGES as readonly string[]).includes(value);
}

function isGapReason(value: string): value is GapReason {
  return (GAP_REASONS as readonly string[]).includes(value);
}
