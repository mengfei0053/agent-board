import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { Envelope, JsonObject } from "../src/protocol.js";
import { invokedDirectly } from "./cli.js";
import { openSocket, type RelaySocket } from "./socket.js";

export type PairedDevice = {
  deviceId: string;
  deviceToken: string;
  role: string;
  boardIds: string[];
  expiresAt: number;
};

export async function createPairCode(httpUrl: string, adminToken: string, boardIds: string[]): Promise<string> {
  const response = await fetch(new URL("/auth/pair/create", httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ boardIds }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body.pairCode !== "string") {
    throw new Error(`pair create failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.pairCode;
}

export async function pairDevice(httpUrl: string, pairCode: string, deviceName: string): Promise<PairedDevice> {
  const response = await fetch(new URL("/auth/pair", httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode, deviceName }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`pair failed ${response.status}: ${JSON.stringify(body)}`);
  if (typeof body.deviceId !== "string" || typeof body.deviceToken !== "string" || !Array.isArray(body.boardIds)) {
    throw new Error("pair response is missing device credentials");
  }
  return {
    deviceId: body.deviceId,
    deviceToken: body.deviceToken,
    role: typeof body.role === "string" ? body.role : "phone",
    boardIds: body.boardIds.filter((id): id is string => typeof id === "string"),
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : 0,
  };
}

export class PhoneSession {
  private constructor(
    readonly device: PairedDevice,
    private readonly socket: RelaySocket,
    private readonly timeoutMs: number,
    private readonly quiet: boolean,
  ) {}

  static async connect(options: {
    httpUrl: string;
    wsUrl: string;
    adminToken: string;
    boardIds: string[];
    deviceName: string;
    timeoutMs?: number;
    quiet?: boolean;
  }): Promise<PhoneSession> {
    const pairCode = await createPairCode(options.httpUrl, options.adminToken, options.boardIds);
    const device = await pairDevice(options.httpUrl, pairCode, options.deviceName);
    if (device.role !== "phone") throw new Error(`expected phone role, got ${device.role}`);
    const socket = await openSocket(options.wsUrl);
    const session = new PhoneSession(device, socket, options.timeoutMs ?? 4_000, options.quiet ?? false);
    const ack = await session.request("client.hello", { token: device.deviceToken, name: options.deviceName });
    if (ack.payload?.deviceId !== device.deviceId || ack.payload?.role !== "phone") {
      throw new Error(`hello ack rejected device binding: ${JSON.stringify(ack.payload)}`);
    }
    session.log(`paired ${device.deviceId} boards=${device.boardIds.join(",")}`);
    return session;
  }

  async listBoards(): Promise<Envelope> {
    return this.request("board.list", {});
  }

  async subscribeTasks(boardId: string, afterSeq?: number): Promise<Envelope> {
    const payload: JsonObject = { boardId };
    if (afterSeq !== undefined) payload.afterSeq = afterSeq;
    return this.request("sub.tasks", payload);
  }

  async subscribeLogs(boardId: string, taskId?: string): Promise<Envelope> {
    const payload: JsonObject = { boardId };
    if (taskId) payload.taskId = taskId;
    return this.request("sub.logs", payload);
  }

  async create(payload: {
    boardId: string;
    title: string;
    prompt: string;
    idempotencyKey: string;
    agent?: string;
    cwd?: string;
  }): Promise<Envelope> {
    const body: JsonObject = {
      boardId: payload.boardId,
      title: payload.title,
      prompt: payload.prompt,
      idempotencyKey: payload.idempotencyKey,
    };
    if (payload.agent) body.agent = payload.agent;
    if (payload.cwd) body.cwd = payload.cwd;
    return this.request("cmd.create", body);
  }

  async continueTask(boardId: string, taskId: string, idempotencyKey: string): Promise<Envelope> {
    return this.request("cmd.continue", { boardId, taskId, idempotencyKey });
  }

  async stopTask(boardId: string, taskId: string, idempotencyKey: string, reason?: string): Promise<Envelope> {
    const payload: JsonObject = { boardId, taskId, idempotencyKey };
    if (reason) payload.reason = reason;
    return this.request("cmd.stop", payload);
  }

  async waitForTask(type: string, taskId: string): Promise<Envelope> {
    const message = await this.socket.inbox.wait((candidate) => matchesTask(candidate, type, taskId), this.timeoutMs);
    if (type === "evt.task.done") this.noteCompletion(message);
    return message;
  }

  async waitForDone(): Promise<Envelope> {
    const message = await this.socket.inbox.wait((candidate) => candidate.type === "evt.task.done", this.timeoutMs);
    this.noteCompletion(message);
    return message;
  }

  messages(): Envelope[] {
    return this.socket.inbox.messages;
  }

  close(): Promise<void> {
    return this.socket.close();
  }

  private async request(type: string, payload: JsonObject): Promise<Envelope> {
    const id = randomUUID();
    this.socket.send({ v: 1, id, type, ts: Date.now(), payload });
    const response = await this.socket.inbox.wait((message) => isTerminal(message, id), this.timeoutMs);
    const stage = response.payload?.stage;
    if (response.type === "err" || stage === "failed" || stage === "timeout") {
      throw new Error(`${type} failed: ${JSON.stringify(response.payload)}`);
    }
    return response;
  }

  private noteCompletion(message: Envelope): void {
    const taskId = typeof message.payload?.taskId === "string" ? message.payload.taskId : "unknown";
    const status = typeof message.payload?.status === "string" ? message.payload.status : "unknown";
    const summary = typeof message.payload?.summary === "string" ? message.payload.summary : status;
    const eventId = typeof message.payload?.eventId === "string" ? message.payload.eventId : "";
    this.log(
      `evt.task.done ${taskId} ${status} eventId=${eventId} — ${summary} (best-effort while this socket is open; P2 dedupes by eventId and may post a system notification)`,
    );
  }

  private log(message: string): void {
    if (!this.quiet) console.log(`[fake-phone] ${message}`);
  }
}

function isTerminal(message: Envelope, id: string): boolean {
  if (message.payload?.ref !== id) return false;
  if (message.type === "err") return true;
  if (message.type !== "ack") return false;
  const stage = message.payload?.stage;
  return stage === "executed" || stage === "failed" || stage === "timeout" || stage === "unknown";
}

function matchesTask(message: Envelope, type: string, taskId: string): boolean {
  if (message.type !== type || !message.payload) return false;
  if (type === "evt.task.done" || type === "evt.log") return message.payload.taskId === taskId;
  if (type === "evt.snapshot") {
    const tasks = message.payload.tasks;
    return Array.isArray(tasks) && tasks.some((item) => isRecord(item) && item.id === taskId);
  }
  const task = message.payload.task;
  return isRecord(task) && task.id === taskId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: "string", default: "http://127.0.0.1:8787" },
      url: { type: "string", default: "ws://127.0.0.1:8787/v1/ws" },
      board: { type: "string", default: "thinkbook-main" },
      admin: { type: "string" },
      name: { type: "string" },
      observe: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: npm run fake-phone -- --admin $ADMIN_TOKEN --board thinkbook-main [--observe]");
    return;
  }
  const adminToken = values.admin ?? process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error("Pass --admin or set ADMIN_TOKEN");
    process.exit(1);
  }
  const boardId = values.board ?? "thinkbook-main";
  const session = await PhoneSession.connect({
    httpUrl: values.http ?? "http://127.0.0.1:8787",
    wsUrl: values.url ?? "ws://127.0.0.1:8787/v1/ws",
    adminToken,
    boardIds: [boardId],
    deviceName: values.name ?? (values.observe ? "observer-phone" : "fake-phone"),
  });
  await session.listBoards();
  if (values.observe) {
    const done = await session.waitForDone();
    console.log(`[fake-phone] observed ${String(done.payload?.status)}`);
    await session.close();
    return;
  }
  await session.subscribeTasks(boardId);
  await session.subscribeLogs(boardId);
  const idempotencyKey = randomUUID();
  const created = await session.create({
    boardId,
    title: "Fix login flake",
    prompt: "Investigate the flaky login test and propose a fix.",
    agent: "cursor",
    cwd: "/home/me/src/app",
    idempotencyKey,
  });
  const task = created.payload?.task;
  if (!isRecord(task) || typeof task.id !== "string") throw new Error("create ack missing task id");
  const again = await session.create({
    boardId,
    title: "Fix login flake",
    prompt: "Investigate the flaky login test and propose a fix.",
    idempotencyKey,
  });
  if (again.payload?.duplicate !== true) throw new Error("second create was not an idempotent replay");
  await session.waitForTask("evt.task", task.id);
  await session.waitForTask("evt.log", task.id);
  await session.waitForTask("evt.snapshot", task.id);
  await session.continueTask(boardId, task.id, randomUUID());
  await session.stopTask(boardId, task.id, randomUUID(), "user tapped stop");
  const done = await session.waitForTask("evt.task.done", task.id);
  console.log(`[fake-phone] done status=${String(done.payload?.status)} eventId=${String(done.payload?.eventId)}`);
  await session.close();
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
