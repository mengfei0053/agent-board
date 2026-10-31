import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;

export const TASK_STATUSES = ["queued", "running", "paused", "succeeded", "failed", "stopped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Read-only archive pages. Never a hot-snapshot or `evt.task` status. */
export const ARCHIVE_STATUS = "archived" as const;
export const ARCHIVE_CAPABILITY = "archive.list";
export const ARCHIVE_PAGE_DEFAULT = 20;
export const ARCHIVE_PAGE_MAX = 50;

export const TERMINAL_TASK_STATUSES = ["succeeded", "failed", "stopped"] as const;
export type TerminalStatus = (typeof TERMINAL_TASK_STATUSES)[number];

export const LOG_STREAMS = ["stdout", "stderr", "system"] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const CMD_TYPES = [
  "cmd.create",
  "cmd.continue",
  "cmd.stop",
  "cmd.workspace.create",
  "cmd.workspace.delete",
  "cmd.detail",
  "cmd.archive.list",
] as const;
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
  "cmd.workspace.create",
  "cmd.workspace.delete",
  "cmd.detail",
  "cmd.archive.list",
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
  /** `archived` is accepted only on `cmd.detail` and `cmd.archive.list` acks. */
  status: TaskStatus | "archived";
  updatedAt: number;
  agent?: string;
  /** Present when the board task is filed in a workspace. */
  workspaceId?: string;
  iteration?: number;
  cwd?: string;
  model?: string;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  pid?: number;
  error?: string;
  prompt?: string;
  output?: string;
  promptPreview?: string;
  outputPreview?: string;
  resumeCommand?: string;
  worktreeBranch?: string;
  promptTruncated?: boolean;
  outputTruncated?: boolean;
  /** Set on `evt.task` and `cmd.detail`. Snapshots omit it and send previews. */
  detail?: "full";
  turns?: TaskTurn[];
  sideJobs?: TaskSideJob[];
};

export type TaskTurn = {
  iteration: number;
  prompt?: string;
  output?: string;
  at?: number;
};

export type TaskSideJob = {
  id: string;
  kind: string;
  title: string;
  status: string;
  summary?: string;
  toolName?: string;
};

export type ParseFailure = {
  ok: false;
  code: "bad_request" | "bad_version" | "bad_type";
  message: string;
  id?: string;
};

type Cursor = { boardId: string; generation: number; seq: number; eventId: string };

export type Incoming =
  | { ok: true; kind: "board.register"; envelope: Envelope; boardId: string; token: string; label?: string; capabilities: string[] }
  | { ok: true; kind: "client.hello"; envelope: Envelope; token: string; name?: string }
  | { ok: true; kind: "board.list"; envelope: Envelope }
  | { ok: true; kind: "sub.tasks"; envelope: Envelope; boardId: string; afterSeq?: number }
  | { ok: true; kind: "sub.logs"; envelope: Envelope; boardId: string; taskId?: string }
  | { ok: true; kind: "cmd.create"; envelope: Envelope; boardId: string; idempotencyKey: string }
  | { ok: true; kind: "cmd.continue"; envelope: Envelope; boardId: string; idempotencyKey: string; taskId: string }
  | { ok: true; kind: "cmd.stop"; envelope: Envelope; boardId: string; idempotencyKey: string; taskId: string }
  | { ok: true; kind: "cmd.workspace.create"; envelope: Envelope; boardId: string; idempotencyKey: string }
  | { ok: true; kind: "cmd.workspace.delete"; envelope: Envelope; boardId: string; idempotencyKey: string }
  | { ok: true; kind: "cmd.detail"; envelope: Envelope; boardId: string; idempotencyKey: string; taskId: string }
  | { ok: true; kind: "cmd.archive.list"; envelope: Envelope; boardId: string; idempotencyKey: string; limit: number; cursor?: string }
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
/** Board workspace ids are nanoid(10), which may start with `_` or `-`. */
const WORKSPACE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
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
    case "cmd.workspace.create":
      return parseCmdWorkspaceCreate(payload, id, ts);
    case "cmd.workspace.delete":
      return parseCmdWorkspaceDelete(payload, id, ts);
    case "cmd.detail":
      return parseCmdDetail(payload, id, ts);
    case "cmd.archive.list":
      return parseCmdArchiveList(payload, id, ts);
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
  const capabilities = readCapabilities(record.value.capabilities);
  if (!capabilities.ok) return failure("bad_request", capabilities.message, id);
  const body: JsonObject = { boardId: boardId.value, token: token.value };
  if (label.value) body.label = label.value;
  if (capabilities.value.length) body.capabilities = capabilities.value;
  return {
    ok: true,
    kind: "board.register",
    envelope: envelope("board.register", id, ts, body),
    boardId: boardId.value,
    token: token.value,
    capabilities: capabilities.value,
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
  const workspaceId = optionalWorkspaceId(record.value.workspaceId, "workspaceId");
  if (!workspaceId.ok) return failure("bad_request", workspaceId.message, id);
  if (workspaceId.value) body.workspaceId = workspaceId.value;
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
  const body: JsonObject = { ...common.body };
  const prompt = optionalMultiline(record.value.prompt, "prompt", 20_000);
  if (!prompt.ok) return failure("bad_request", prompt.message, id);
  if (prompt.value) body.prompt = prompt.value;
  return {
    ok: true,
    kind,
    envelope: envelope(kind, id, ts, body),
    boardId: common.boardId,
    idempotencyKey: common.idempotencyKey,
    taskId: common.taskId,
  };
}

function parseCmdArchiveList(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const key = readKey(record.value.idempotencyKey);
  if (!key.ok) return failure("bad_request", key.message, id);
  let limit = ARCHIVE_PAGE_DEFAULT;
  if (record.value.limit !== undefined) {
    const parsed = readInt(record.value.limit, "limit", 1);
    if (!parsed.ok) return failure("bad_request", parsed.message, id);
    if (parsed.value > ARCHIVE_PAGE_MAX) return failure("bad_request", `limit must be at most ${ARCHIVE_PAGE_MAX}`, id);
    limit = parsed.value;
  }
  let cursor: string | undefined;
  if (record.value.cursor !== undefined) {
    const parsed = readArchiveCursor(record.value.cursor);
    if (!parsed.ok) return failure("bad_request", parsed.message, id);
    cursor = parsed.value;
  }
  const body: JsonObject = { boardId: boardId.value, idempotencyKey: key.value, limit };
  if (cursor) body.cursor = cursor;
  return {
    ok: true,
    kind: "cmd.archive.list",
    envelope: envelope("cmd.archive.list", id, ts, body),
    boardId: boardId.value,
    idempotencyKey: key.value,
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

function parseCmdDetail(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const common = readCmdTarget(record.value, id);
  if (!common.ok) return common.failure;
  return {
    ok: true,
    kind: "cmd.detail",
    envelope: envelope("cmd.detail", id, ts, common.body),
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

function parseCmdWorkspaceCreate(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const key = readKey(record.value.idempotencyKey);
  if (!key.ok) return failure("bad_request", key.message, id);
  const name = readText(record.value.name, "name", 1, 200);
  if (!name.ok) return failure("bad_request", name.message, id);
  const path = readText(record.value.path, "path", 1, 1024);
  if (!path.ok) return failure("bad_request", path.message, id);
  if (path.value.includes("://")) return failure("bad_request", "path must be a local path", id);
  if (!path.value.startsWith("/")) return failure("bad_request", "path must be an absolute path", id);
  return {
    ok: true,
    kind: "cmd.workspace.create",
    envelope: envelope("cmd.workspace.create", id, ts, {
      boardId: boardId.value,
      idempotencyKey: key.value,
      name: name.value.trim(),
      path: path.value.trim(),
    }),
    boardId: boardId.value,
    idempotencyKey: key.value,
  };
}

function parseCmdWorkspaceDelete(payload: unknown, id: string, ts: number): Incoming {
  const record = requireRecord(payload, id);
  if (!record.ok) return record.failure;
  const boardId = readBoardId(record.value.boardId, "boardId");
  if (!boardId.ok) return failure("bad_request", boardId.message, id);
  const key = readKey(record.value.idempotencyKey);
  if (!key.ok) return failure("bad_request", key.message, id);
  const workspaceId = readWorkspaceId(record.value.workspaceId, "workspaceId");
  if (!workspaceId.ok) return failure("bad_request", workspaceId.message, id);
  return {
    ok: true,
    kind: "cmd.workspace.delete",
    envelope: envelope("cmd.workspace.delete", id, ts, {
      boardId: boardId.value,
      idempotencyKey: key.value,
      workspaceId: workspaceId.value,
    }),
    boardId: boardId.value,
    idempotencyKey: key.value,
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
    return failure("bad_request", "cmd must be a known command type", id);
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
    const task = readTask(record.value.task, false, true);
    if (!task.ok) return failure("bad_request", task.message, id);
    body.task = taskToJson(task.task);
  }
  if (record.value.archive !== undefined) {
    const archive = readArchive(record.value.archive);
    if (!archive.ok) return failure("bad_request", archive.message, id);
    body.archive = archive.value;
  }
  if (record.value.workspace !== undefined) {
    const workspace = readWorkspace(record.value.workspace, "workspace");
    if (!workspace.ok) return failure("bad_request", workspace.message, id);
    body.workspace = workspace.value;
  }
  if (record.value.deleted !== undefined) {
    const deleted = readWorkspaceId(record.value.deleted, "deleted");
    if (!deleted.ok) return failure("bad_request", deleted.message, id);
    body.deleted = deleted.value;
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
    if (item.capabilities !== undefined) {
      const capabilities = readCapabilities(item.capabilities);
      if (!capabilities.ok) return { ok: false, message: capabilities.message };
      entry.capabilities = capabilities.value;
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
    const row = readWorkspace(item);
    if (!row.ok) return row;
    rows.push(row.value);
  }
  return { ok: true, value: rows };
}

function readWorkspace(
  value: unknown,
  label = "workspaces",
): { ok: true; value: JsonObject } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "workspace must be an object" };
  const id = readWorkspaceId(value.id, `${label}.id`);
  if (!id.ok) return { ok: false, message: id.message };
  const name = readText(value.name, `${label}.name`, 1, 200);
  if (!name.ok) return name;
  const path = readText(value.path, `${label}.path`, 1, 1024);
  if (!path.ok) return path;
  if (path.value.includes("://")) return { ok: false, message: `${label}.path must be a local path` };
  if (typeof value.isGit !== "boolean") return { ok: false, message: `${label}.isGit must be a boolean` };
  return { ok: true, value: { id: id.value, name: name.value, path: path.value, isGit: value.isGit } };
}

function readTask(
  value: unknown,
  terminalOnly: boolean,
  allowArchived = false,
): { ok: true; task: Task } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "task must be an object" };
  const id = readBoardId(value.id, "task.id");
  if (!id.ok) return id;
  const title = readText(value.title, "task.title", 1, 200);
  if (!title.ok) return title;
  const status = value.status;
  if (typeof status !== "string" || !acceptTaskStatus(status, allowArchived)) {
    return { ok: false, message: "task.status is invalid" };
  }
  if (terminalOnly && !isTerminalStatus(status)) {
    return { ok: false, message: "evt.task.done requires status succeeded, failed, or stopped" };
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    return { ok: false, message: "task.updatedAt must be a finite number" };
  }
  const task: Task = { id: id.value, title: title.value, status, updatedAt: value.updatedAt };
  if (value.agent !== undefined) {
    const agent = readText(value.agent, "task.agent", 1, 64);
    if (!agent.ok) return agent;
    task.agent = agent.value;
  }
  const workspaceId = optionalWorkspaceId(value.workspaceId, "task.workspaceId");
  if (!workspaceId.ok) return workspaceId;
  if (workspaceId.value) task.workspaceId = workspaceId.value;
  const detail = readTaskDetail(value);
  if (!detail.ok) return detail;
  Object.assign(task, detail.fields);
  return { ok: true, task };
}

function taskToJson(task: Task): JsonObject {
  const json: JsonObject = { id: task.id, title: task.title, status: task.status, updatedAt: task.updatedAt };
  if (task.agent) json.agent = task.agent;
  if (task.workspaceId) json.workspaceId = task.workspaceId;
  if (task.iteration != null) json.iteration = task.iteration;
  if (task.cwd) json.cwd = task.cwd;
  if (task.model) json.model = task.model;
  if (task.sessionId) json.sessionId = task.sessionId;
  if (task.startedAt != null) json.startedAt = task.startedAt;
  if (task.endedAt != null) json.endedAt = task.endedAt;
  if (task.exitCode != null) json.exitCode = task.exitCode;
  if (task.pid != null) json.pid = task.pid;
  if (task.error) json.error = task.error;
  if (task.prompt) json.prompt = task.prompt;
  if (task.output) json.output = task.output;
  if (task.promptPreview) json.promptPreview = task.promptPreview;
  if (task.outputPreview) json.outputPreview = task.outputPreview;
  if (task.resumeCommand) json.resumeCommand = task.resumeCommand;
  if (task.worktreeBranch) json.worktreeBranch = task.worktreeBranch;
  if (task.promptTruncated) json.promptTruncated = true;
  if (task.outputTruncated) json.outputTruncated = true;
  if (task.detail) json.detail = task.detail;
  if (task.turns) json.turns = task.turns.map((turn) => {
    const row: JsonObject = { iteration: turn.iteration };
    if (turn.prompt) row.prompt = turn.prompt;
    if (turn.output) row.output = turn.output;
    if (turn.at != null) row.at = turn.at;
    return row;
  });
  if (task.sideJobs) json.sideJobs = task.sideJobs.map((job) => {
    const row: JsonObject = { id: job.id, kind: job.kind, title: job.title, status: job.status };
    if (job.summary) row.summary = job.summary;
    if (job.toolName) row.toolName = job.toolName;
    return row;
  });
  return json;
}

function readTaskDetail(
  value: Record<string, unknown>,
): { ok: true; fields: Partial<Task> } | { ok: false; message: string } {
  const fields: Partial<Task> = {};
  const iteration = optionalBoundedInt(value.iteration, "task.iteration", 1, 1_000_000);
  if (!iteration.ok) return iteration;
  if (iteration.value != null) fields.iteration = iteration.value;
  const cwd = optionalMultiline(value.cwd, "task.cwd", 1024);
  if (!cwd.ok) return cwd;
  if (cwd.value) {
    if (cwd.value.includes("://")) return { ok: false, message: "task.cwd must be a local path" };
    fields.cwd = cwd.value;
  }
  const model = optionalMultiline(value.model, "task.model", 200);
  if (!model.ok) return model;
  if (model.value) fields.model = model.value;
  const sessionId = optionalMultiline(value.sessionId, "task.sessionId", 200);
  if (!sessionId.ok) return sessionId;
  if (sessionId.value) fields.sessionId = sessionId.value;
  const startedAt = optionalBoundedInt(value.startedAt, "task.startedAt", 0, Number.MAX_SAFE_INTEGER);
  if (!startedAt.ok) return startedAt;
  if (startedAt.value != null) fields.startedAt = startedAt.value;
  const endedAt = optionalBoundedInt(value.endedAt, "task.endedAt", 0, Number.MAX_SAFE_INTEGER);
  if (!endedAt.ok) return endedAt;
  if (endedAt.value != null) fields.endedAt = endedAt.value;
  const exitCode = optionalBoundedInt(value.exitCode, "task.exitCode", -1_000_000, 1_000_000);
  if (!exitCode.ok) return exitCode;
  if (exitCode.value != null) fields.exitCode = exitCode.value;
  const pid = optionalBoundedInt(value.pid, "task.pid", 1, Number.MAX_SAFE_INTEGER);
  if (!pid.ok) return pid;
  if (pid.value != null) fields.pid = pid.value;
  const error = optionalMultiline(value.error, "task.error", 2_000);
  if (!error.ok) return error;
  if (error.value) fields.error = error.value;
  const prompt = optionalMultiline(value.prompt, "task.prompt", 4_000);
  if (!prompt.ok) return prompt;
  if (prompt.value) fields.prompt = prompt.value;
  const output = optionalMultiline(value.output, "task.output", 4_000);
  if (!output.ok) return output;
  if (output.value) fields.output = output.value;
  const promptPreview = optionalMultiline(value.promptPreview, "task.promptPreview", 400);
  if (!promptPreview.ok) return promptPreview;
  if (promptPreview.value) fields.promptPreview = promptPreview.value;
  const outputPreview = optionalMultiline(value.outputPreview, "task.outputPreview", 400);
  if (!outputPreview.ok) return outputPreview;
  if (outputPreview.value) fields.outputPreview = outputPreview.value;
  const resumeCommand = optionalMultiline(value.resumeCommand, "task.resumeCommand", 2_000);
  if (!resumeCommand.ok) return resumeCommand;
  if (resumeCommand.value) fields.resumeCommand = resumeCommand.value;
  const branch = optionalMultiline(value.worktreeBranch, "task.worktreeBranch", 200);
  if (!branch.ok) return branch;
  if (branch.value) fields.worktreeBranch = branch.value;
  const promptTruncated = optionalFlag(value.promptTruncated, "task.promptTruncated");
  if (!promptTruncated.ok) return promptTruncated;
  if (promptTruncated.value) fields.promptTruncated = true;
  const outputTruncated = optionalFlag(value.outputTruncated, "task.outputTruncated");
  if (!outputTruncated.ok) return outputTruncated;
  if (outputTruncated.value) fields.outputTruncated = true;
  if (value.detail !== undefined) {
    if (value.detail !== "full") return { ok: false, message: "task.detail is invalid" };
    fields.detail = "full";
  }
  const turns = readTurns(value.turns);
  if (!turns.ok) return turns;
  if (turns.value) fields.turns = turns.value;
  const sideJobs = readSideJobs(value.sideJobs);
  if (!sideJobs.ok) return sideJobs;
  if (sideJobs.value) fields.sideJobs = sideJobs.value;
  return { ok: true, fields };
}

function readTurns(value: unknown): { ok: true; value?: TaskTurn[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, message: "task.turns must be an array" };
  if (value.length > 12) return { ok: false, message: "task.turns exceeds 12 items" };
  const turns: TaskTurn[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, message: "task.turns entry must be an object" };
    const iteration = optionalBoundedInt(item.iteration, "task.turns.iteration", 1, 1_000_000);
    if (!iteration.ok || iteration.value == null) return { ok: false, message: "task.turns.iteration is invalid" };
    const turn: TaskTurn = { iteration: iteration.value };
    const prompt = optionalMultiline(item.prompt, "task.turns.prompt", 4_000);
    if (!prompt.ok) return prompt;
    if (prompt.value) turn.prompt = prompt.value;
    const output = optionalMultiline(item.output, "task.turns.output", 4_000);
    if (!output.ok) return output;
    if (output.value) turn.output = output.value;
    const at = optionalBoundedInt(item.at, "task.turns.at", 0, Number.MAX_SAFE_INTEGER);
    if (!at.ok) return at;
    if (at.value != null) turn.at = at.value;
    turns.push(turn);
  }
  return { ok: true, value: turns };
}

function readSideJobs(value: unknown): { ok: true; value?: TaskSideJob[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, message: "task.sideJobs must be an array" };
  if (value.length > 20) return { ok: false, message: "task.sideJobs exceeds 20 items" };
  const jobs: TaskSideJob[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, message: "task.sideJobs entry must be an object" };
    const id = optionalMultiline(item.id, "task.sideJobs.id", 80);
    if (!id.ok || !id.value) return { ok: false, message: "task.sideJobs.id is invalid" };
    const kind = optionalMultiline(item.kind, "task.sideJobs.kind", 32);
    if (!kind.ok || !kind.value) return { ok: false, message: "task.sideJobs.kind is invalid" };
    const title = optionalMultiline(item.title, "task.sideJobs.title", 200);
    if (!title.ok || !title.value) return { ok: false, message: "task.sideJobs.title is invalid" };
    const status = optionalMultiline(item.status, "task.sideJobs.status", 32);
    if (!status.ok || !status.value) return { ok: false, message: "task.sideJobs.status is invalid" };
    const job: TaskSideJob = { id: id.value, kind: kind.value, title: title.value, status: status.value };
    const summary = optionalMultiline(item.summary, "task.sideJobs.summary", 400);
    if (!summary.ok) return summary;
    if (summary.value) job.summary = summary.value;
    const toolName = optionalMultiline(item.toolName, "task.sideJobs.toolName", 80);
    if (!toolName.ok) return toolName;
    if (toolName.value) job.toolName = toolName.value;
    jobs.push(job);
  }
  return { ok: true, value: jobs };
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

function optionalMultiline(
  value: unknown,
  field: string,
  max: number,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || value.length < 1 || value.length > max || !isMultiline(value)) {
    return { ok: false, message: `${field} must be 1-${max} characters` };
  }
  return { ok: true, value };
}

function optionalBoundedInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return { ok: false, message: `${field} must be an integer from ${min} to ${max}` };
  }
  return { ok: true, value: value as number };
}

function optionalFlag(
  value: unknown,
  field: string,
): { ok: true; value?: boolean } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "boolean") return { ok: false, message: `${field} must be a boolean` };
  return { ok: true, value };
}

function isMultiline(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function readWorkspaceId(value: unknown, field: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !WORKSPACE_ID.test(value)) {
    return { ok: false, message: `${field} must be 1-64 characters of letters, digits, '_', '.', or '-'` };
  }
  return { ok: true, value };
}

function optionalWorkspaceId(
  value: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  return readWorkspaceId(value, field);
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

function acceptTaskStatus(value: string, allowArchived: boolean): value is Task["status"] {
  if (value === ARCHIVE_STATUS) return allowArchived;
  return isTaskStatus(value);
}

const ARCHIVE_CURSOR = /^([0-9]{1,16}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const KNOWN_CAPABILITIES = new Set<string>([ARCHIVE_CAPABILITY]);

function readCapabilities(value: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > 8) {
    return { ok: false, message: "capabilities must be an array of at most 8 names" };
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !KNOWN_CAPABILITIES.has(item) || names.includes(item)) {
      return { ok: false, message: "capabilities contains an unknown name" };
    }
    names.push(item);
  }
  return { ok: true, value: names };
}

function readArchiveCursor(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !ARCHIVE_CURSOR.test(value)) {
    return { ok: false, message: "cursor is invalid" };
  }
  return { ok: true, value };
}

function readArchive(value: unknown): { ok: true; value: JsonObject } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "archive must be an object" };
  if (!Array.isArray(value.tasks)) return { ok: false, message: "archive.tasks must be an array" };
  if (value.tasks.length > ARCHIVE_PAGE_MAX) return { ok: false, message: "archive.tasks exceeds 50 items" };
  const tasks: Json[] = [];
  for (const item of value.tasks) {
    const task = readTask(item, false, true);
    if (!task.ok) return task;
    if (task.task.status !== ARCHIVE_STATUS) {
      return { ok: false, message: "archive.tasks status must be archived" };
    }
    tasks.push(taskToJson(task.task));
  }
  const body: JsonObject = { tasks };
  if (value.nextCursor !== undefined) {
    const cursor = readArchiveCursor(value.nextCursor);
    if (!cursor.ok) return cursor;
    body.nextCursor = cursor.value;
  }
  return { ok: true, value: body };
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
