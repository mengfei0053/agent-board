import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { Envelope, JsonObject, TaskStatus, TerminalStatus } from "../src/protocol.js";
import { invokedDirectly } from "./cli.js";
import { openSocket, type RelaySocket } from "./socket.js";

type LiveTask = {
  id: string;
  title: string;
  status: TaskStatus;
  updatedAt: number;
  agent?: string;
};

export type FakeBoardHandle = {
  ready: Promise<void>;
  createCount: () => number;
  emitTaskDone: (input?: { taskId?: string; status?: TerminalStatus; summary?: string }) => void;
  emitDuplicate: () => void;
  emitTaskUpdate: () => void;
  errors: () => Envelope[];
  isOpen: () => boolean;
  close: () => Promise<void>;
};

export async function startFakeBoard(options: {
  wsUrl: string;
  boardId: string;
  token: string;
  label?: string;
  quiet?: boolean;
}): Promise<FakeBoardHandle> {
  const tasks = new Map<string, LiveTask>();
  const byRequest = new Map<string, string>();
  const terminal = new Set<string>();
  const errors: Envelope[] = [];
  let socket: RelaySocket | null = null;
  let generation = 0;
  let seq = 0;
  let creates = 0;
  let lastDone: Envelope | null = null;

  const say = (message: string) => {
    if (!options.quiet) console.log(`[fake-board] ${message}`);
  };

  const send = (type: string, payload: JsonObject) => {
    const message: Envelope = { v: 1, id: randomUUID(), type, ts: Date.now(), payload };
    socket?.send(message);
    if (type === "evt.task.done") lastDone = message;
    return message;
  };

  const taskJson = (task: LiveTask): JsonObject => {
    const json: JsonObject = { id: task.id, title: task.title, status: task.status, updatedAt: task.updatedAt };
    if (task.agent) json.agent = task.agent;
    return json;
  };

  const emit = (type: string, fields: JsonObject) => {
    seq += 1;
    const eventId = randomUUID();
    const payload: JsonObject = { boardId: options.boardId, generation, seq, eventId, ...fields };
    if (type === "evt.snapshot") payload.version = seq;
    return send(type, payload);
  };

  const sendSnapshot = () => {
    emit("evt.snapshot", { capturedAt: Date.now(), tasks: [...tasks.values()].map(taskJson) });
  };

  socket = await openSocket(options.wsUrl, (message) => {
    if (message.type === "err") {
      errors.push(message);
      say(`err ${JSON.stringify(message.payload)}`);
      return;
    }
    if (message.type === "cmd.create") onCreate(message);
    if (message.type === "cmd.continue") onContinue(message);
    if (message.type === "cmd.stop") onStop(message);
  });

  const registerId = randomUUID();
  socket.send({
    v: 1,
    id: registerId,
    type: "board.register",
    ts: Date.now(),
    payload: { boardId: options.boardId, token: options.token, label: options.label ?? "ThinkBook fake connector" },
  });

  const ready = socket.inbox
    .wait((message) => (message.type === "ack" || message.type === "err") && message.payload?.ref === registerId, 3_000)
    .then((message) => {
      if (message.type !== "ack" || message.payload?.generation === undefined) {
        throw new Error(`board register failed: ${JSON.stringify(message.payload)}`);
      }
      if (typeof message.payload.generation !== "number") throw new Error("register ack missing generation");
      generation = message.payload.generation;
      sendSnapshot();
      say(`registered ${options.boardId} generation ${generation}`);
    });

  function requirePayload(message: Envelope): Record<string, JsonObject[string]> {
    if (!message.payload) throw new Error("command missing payload");
    return message.payload;
  }

  function ack(ref: string, task: LiveTask): void {
    send("ack", { ref, stage: "executed", task: taskJson(task) });
  }

  function onCreate(message: Envelope): void {
    creates += 1;
    const payload = requirePayload(message);
    const idempotencyKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : "";
    const existing = byRequest.get(idempotencyKey);
    const prior = existing ? tasks.get(existing) : undefined;
    if (prior) {
      ack(message.id, prior);
      say(`cmd.create duplicate ${prior.id}`);
      return;
    }
    const task: LiveTask = {
      id: `task_${randomBytes(4).toString("hex")}`,
      title: String(payload.title ?? "untitled"),
      status: "queued",
      updatedAt: Date.now(),
    };
    if (typeof payload.agent === "string") task.agent = payload.agent;
    tasks.set(task.id, task);
    if (idempotencyKey) byRequest.set(idempotencyKey, task.id);
    ack(message.id, task);
    task.status = "running";
    task.updatedAt = Date.now();
    emit("evt.task", { task: taskJson(task) });
    emit("evt.log", { taskId: task.id, stream: "system", line: "connector accepted create" });
    sendSnapshot();
    say(`cmd.create -> ${task.id}`);
  }

  function onContinue(message: Envelope): void {
    const payload = requirePayload(message);
    const task = typeof payload.taskId === "string" ? tasks.get(payload.taskId) : undefined;
    if (!task) {
      send("err", { ref: message.id, code: "unknown_task", message: "task not found" });
      return;
    }
    task.status = "running";
    task.updatedAt = Date.now();
    ack(message.id, task);
    emit("evt.task", { task: taskJson(task) });
    emit("evt.log", { taskId: task.id, stream: "system", line: "continued" });
    say(`cmd.continue ${task.id}`);
  }

  function onStop(message: Envelope): void {
    const payload = requirePayload(message);
    const task = typeof payload.taskId === "string" ? tasks.get(payload.taskId) : undefined;
    if (!task) {
      send("err", { ref: message.id, code: "unknown_task", message: "task not found" });
      return;
    }
    const reason = typeof payload.reason === "string" ? payload.reason : undefined;
    say(`cmd.stop ${task.id}`);
    if (terminal.has(task.id)) {
      ack(message.id, task);
      say(`cmd.stop ${task.id} already terminal`);
      return;
    }
    task.status = "stopped";
    task.updatedAt = Date.now();
    terminal.add(task.id);
    ack(message.id, task);
    emit("evt.task", { task: taskJson(task) });
    emit("evt.log", { taskId: task.id, stream: "system", line: reason ? `stopped: ${reason}` : "stopped" });
    sendSnapshot();
    emit("evt.task.done", {
      taskId: task.id,
      status: "stopped",
      title: task.title,
      summary: reason ? `Stopped: ${reason}` : "Stopped by client",
    });
    say(`evt.task.done ${task.id} stopped`);
  }

  return {
    ready,
    createCount: () => creates,
    errors: () => [...errors],
    isOpen: () => socket?.isOpen() ?? false,
    emitTaskDone: (input) => {
      const taskId = input?.taskId ?? `task_${randomBytes(4).toString("hex")}`;
      if (terminal.has(taskId)) return;
      terminal.add(taskId);
      const status = input?.status ?? "succeeded";
      emit("evt.task.done", {
        taskId,
        status,
        title: "offline probe",
        summary: input?.summary ?? "emitted with no phone online",
      });
      say(`evt.task.done ${taskId} ${status}`);
    },
    emitDuplicate: () => {
      if (!lastDone) return;
      socket?.send(lastDone);
      say("replayed last evt.task.done");
    },
    emitTaskUpdate: () => {
      const task = [...tasks.values()][0];
      const current: LiveTask = task ?? {
        id: `task_${randomBytes(4).toString("hex")}`,
        title: "reconnect probe",
        status: "running",
        updatedAt: Date.now(),
      };
      if (!task) tasks.set(current.id, current);
      current.updatedAt = Date.now();
      emit("evt.task", { task: taskJson(current) });
      say(`evt.task ${current.id}`);
    },
    close: async () => {
      await socket?.close();
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: "ws://127.0.0.1:8787/v1/ws" },
      board: { type: "string", default: "thinkbook-main" },
      token: { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: npm run fake-board -- --board thinkbook-main --token $BOARD_TOKEN");
    return;
  }
  const token = values.token ?? process.env.BOARD_TOKEN;
  if (!token) {
    console.error("Pass --token or set BOARD_TOKEN");
    process.exit(1);
  }
  const board = await startFakeBoard({
    wsUrl: values.url ?? "ws://127.0.0.1:8787/v1/ws",
    boardId: values.board ?? "thinkbook-main",
    token,
    ...(values.label ? { label: values.label } : {}),
  });
  await board.ready;
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await board.close();
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
