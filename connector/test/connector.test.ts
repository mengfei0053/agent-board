import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { startServer, type StartedServer } from "../../relay/src/server.js";
import { BoardClient } from "../src/board.js";
import { ConnectorSession } from "../src/session.js";
import { startConnector, type ConnectorHandle } from "../src/run.js";
import { startMockBoard, type MockBoard } from "./mock-board.js";

type Env = { v: number; id: string; type: string; ts: number; payload?: Record<string, unknown> };

test("connector maps commands and emits one completion", { timeout: 20_000 }, async () => {
  const adminToken = "admin-connector-token";
  const boardToken = "board-connector-token";
  const relay = await startServer({
    host: "127.0.0.1",
    port: 0,
    adminToken,
    boardToken,
    log: () => {},
    cmdTimeoutMs: 4_000,
  });
  const board = await startMockBoard();
  const connector = startConnector({
    relayWsUrl: relay.wsUrl,
    boardId: "thinkbook-main",
    boardToken,
    boardBaseUrl: board.url,
    label: "ThinkBook",
    reconnectMinMs: 40,
    reconnectMaxMs: 200,
    httpTimeoutMs: 2_000,
  }, () => {});
  let phone: WebSocket | null = null;
  try {
    await connector.ready;
    assert.equal(connector.generation(), 1);
    const client = await openPhone(relay, adminToken);
    phone = client.socket;
    await client.request("sub.tasks", { boardId: "thinkbook-main" });
    await client.request("sub.logs", { boardId: "thinkbook-main" });
    const snapshot = await client.wait((message) => message.type === "evt.snapshot" && message.payload?.generation === 1);
    assert.equal(snapshot.payload?.seq, snapshot.payload?.version);

    const created = await client.request("cmd.create", {
      boardId: "thinkbook-main",
      idempotencyKey: "idem-connector-1",
      title: "Fix login flake",
      prompt: "Investigate the flaky login test.",
      agent: "cursor",
      cwd: "/home/me/src/app",
    });
    assert.equal(created.payload?.stage, "executed");
    const task = created.payload?.task;
    assert.ok(isRecord(task) && typeof task.id === "string");
    const taskId = task.id as string;
    const create = board.requests.find((request) => request.method === "POST" && request.path === "/api/tasks");
    assert.ok(create);
    assert.equal(isRecord(create?.body) ? create?.body.kind : undefined, "cursor");
    assert.equal(isRecord(create?.body) ? create?.body.cwd : undefined, "/home/me/src/app");
    assert.equal(isRecord(create?.body) ? create?.body.start : undefined, true);

    const missingCwd = await client.request("cmd.create", {
      boardId: "thinkbook-main",
      idempotencyKey: "idem-connector-2",
      title: "No path",
      prompt: "should not run",
      agent: "cursor",
    });
    assert.equal(missingCwd.payload?.code, "cwd_required");
    assert.equal(board.requests.filter((request) => request.path === "/api/tasks" && request.method === "POST").length, 1);

    await client.request("cmd.continue", {
      boardId: "thinkbook-main",
      taskId,
      idempotencyKey: "idem-connector-3",
    });
    await client.request("cmd.continue", {
      boardId: "thinkbook-main",
      taskId,
      idempotencyKey: "idem-connector-3b",
      prompt: "keep this exact prompt",
    });
    const continues = board.requests.filter((request) => request.path === `/api/tasks/${taskId}/continue`);
    assert.equal(continues.length, 2);
    assert.equal(isRecord(continues[0]?.body) ? continues[0].body.prompt : "present", undefined);
    assert.equal(isRecord(continues[1]?.body) ? continues[1].body.prompt : undefined, "keep this exact prompt");

    board.emit("task_log", { type: "task_log", taskId, line: "building", at: Date.now() });
    const log = await client.wait((message) => message.type === "evt.log" && message.payload?.taskId === taskId);
    assert.equal(log.payload?.line, "building");

    const stopped = await client.request("cmd.stop", {
      boardId: "thinkbook-main",
      taskId,
      idempotencyKey: "idem-connector-4",
      reason: "user tapped stop",
    });
    assert.equal(stopped.payload?.stage, "executed");
    assert.ok(board.requests.some((request) => request.path === `/api/tasks/${taskId}/stop`));
    const done = await client.wait((message) => message.type === "evt.task.done" && message.payload?.taskId === taskId);
    assert.equal(done.payload?.status, "stopped");
    assert.equal(done.payload?.generation, 1);
    assert.equal(typeof done.payload?.seq, "number");
    assert.equal(typeof done.payload?.eventId, "string");

    board.emit("task_upsert", {
      type: "task_upsert",
      task: { id: taskId, title: "Fix login flake", status: "stopped", updatedAt: Date.now(), kind: "cursor" },
    });
    board.emit("ping", {});
    board.emit("task_delete", { type: "task_delete", taskIds: ["missing_task"] });
    await delay(80);
    assert.equal(client.inbox.filter((message) => message.type === "evt.task.done" && message.payload?.taskId === taskId).length, 1);

    board.failCreates = 1;
    const failed = await client.request("cmd.create", {
      boardId: "thinkbook-main",
      idempotencyKey: "idem-connector-5",
      title: "Broken",
      prompt: "board is down",
      agent: "codex",
      cwd: "/tmp/app",
    });
    assert.equal(failed.payload?.stage, "failed");
    assert.equal(failed.payload?.code, "board_http");

    connector.disconnect();
    const next = await client.wait((message) => message.type === "evt.snapshot" && message.payload?.generation === 2, 4_000);
    assert.equal(next.payload?.seq, 1);
    assert.equal(connector.generation(), 2);
  } finally {
    phone?.close();
    await connector.close();
    await board.close();
    await relay.close();
  }
});

test("a command that arrives while the first snapshot is still loading is not dropped", { timeout: 20_000 }, async () => {
  const adminToken = "admin-connector-hold";
  const boardToken = "board-connector-hold";
  const relay = await startServer({
    host: "127.0.0.1",
    port: 0,
    adminToken,
    boardToken,
    log: () => {},
    cmdTimeoutMs: 4_000,
  });
  const board = await startMockBoard();
  let releaseList: () => void = () => {};
  board.listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const connector = startConnector({
    relayWsUrl: relay.wsUrl,
    boardId: "thinkbook-main",
    boardToken,
    boardBaseUrl: board.url,
    label: "ThinkBook",
    reconnectMinMs: 40,
    reconnectMaxMs: 200,
    httpTimeoutMs: 2_000,
  }, () => {});
  let phone: WebSocket | null = null;
  try {
    await waitForHealth(relay.httpUrl, (health) => health.boardsOnline === 1);
    const client = await openPhone(relay, adminToken);
    phone = client.socket;
    const pending = client.request("cmd.create", {
      boardId: "thinkbook-main",
      idempotencyKey: "idem-during-snapshot",
      title: "Arrived early",
      prompt: "must not be dropped",
      agent: "pi",
      cwd: "/home/me/src/app",
    });
    await delay(40);
    releaseList();
    const result = await pending;
    assert.equal(result.payload?.stage, "executed");
    assert.equal(board.requests.some((request) => request.method === "POST" && request.path === "/api/tasks"), true);
    await connector.ready;
  } finally {
    releaseList();
    phone?.close();
    await connector.close();
    await board.close();
    await relay.close();
  }
});

test("a command buffered before the session uses the register generation", { timeout: 20_000 }, async () => {
  const adminToken = "admin-connector-gen";
  const boardToken = "board-connector-gen";
  const relay = await startServer({
    host: "127.0.0.1",
    port: 0,
    adminToken,
    boardToken,
    log: () => {},
    cmdTimeoutMs: 4_000,
  });
  const board = await startMockBoard();
  board.seed({
    id: "task_01",
    title: "Fix login flake",
    status: "running",
    updatedAt: Date.now(),
    kind: "cursor",
  });
  let releaseSession: () => void = () => {};
  const connector = startConnector({
    relayWsUrl: relay.wsUrl,
    boardId: "thinkbook-main",
    boardToken,
    boardBaseUrl: board.url,
    label: "ThinkBook",
    reconnectMinMs: 40,
    reconnectMaxMs: 200,
    httpTimeoutMs: 2_000,
    beforeSession: () => new Promise<void>((resolve) => {
      releaseSession = resolve;
    }),
  }, () => {});
  let phone: WebSocket | null = null;
  try {
    await waitForHealth(relay.httpUrl, (health) => health.boardsOnline === 1);
    const client = await openPhone(relay, adminToken);
    phone = client.socket;
    await client.request("sub.tasks", { boardId: "thinkbook-main" });
    const pending = client.request("cmd.stop", {
      boardId: "thinkbook-main",
      taskId: "task_01",
      idempotencyKey: "idem-before-session",
    });
    await delay(100);
    releaseSession();
    const stopped = await pending;
    assert.equal(stopped.payload?.stage, "executed");
    const done = await client.wait((message) => message.type === "evt.task.done" && message.payload?.taskId === "task_01");
    assert.equal(done.payload?.generation, 1);
    assert.equal(done.payload?.status, "stopped");
    await connector.ready;
    await delay(40);
    const events = client.inbox.filter((message) => message.type === "evt.task" || message.type === "evt.task.done" || message.type === "evt.snapshot");
    assert.ok(events.length > 0);
    assert.equal(events.every((message) => message.payload?.generation === 1), true);
    assert.equal(client.inbox.filter((message) => message.type === "evt.task.done").length, 1);
  } finally {
    releaseSession();
    phone?.close();
    await connector.close();
    await board.close();
    await relay.close();
  }
});

test("the same idempotency key does not create twice in one connector session", async () => {
  const board = await startMockBoard();
  try {
    const session = new ConnectorSession("thinkbook-main", new BoardClient(board.url, 2_000), () => {}, 1);
    const payload = {
      boardId: "thinkbook-main",
      idempotencyKey: "idem-session-1",
      title: "Fix login flake",
      prompt: "Investigate the flaky login test.",
      agent: "cursor",
      cwd: "/home/me/src/app",
      useGitWorktree: true,
    };
    await session.onMessage({ v: 1, id: "create-a", type: "cmd.create", ts: 1, payload });
    await session.onMessage({ v: 1, id: "create-b", type: "cmd.create", ts: 2, payload });
    const posts = board.requests.filter((request) => request.method === "POST" && request.path === "/api/tasks");
    assert.equal(posts.length, 1);
    assert.equal(isRecord(posts[0]?.body) ? posts[0]?.body.useGitWorktree : undefined, true);
  } finally {
    await board.close();
  }
});

test("git worktree flag is forwarded once and task delete keeps workspaces", { timeout: 20_000 }, async () => {
  const adminToken = "admin-connector-wt";
  const boardToken = "board-connector-wt";
  const relay = await startServer({
    host: "127.0.0.1",
    port: 0,
    adminToken,
    boardToken,
    log: () => {},
    cmdTimeoutMs: 4_000,
  });
  const board = await startMockBoard();
  board.seedWorkspace({ id: "ws_app", name: "App", path: "/home/me/src/app", isGit: true });
  const connector = startConnector({
    relayWsUrl: relay.wsUrl,
    boardId: "thinkbook-main",
    boardToken,
    boardBaseUrl: board.url,
    label: "ThinkBook",
    reconnectMinMs: 40,
    reconnectMaxMs: 200,
    httpTimeoutMs: 2_000,
  }, () => {});
  let phone: WebSocket | null = null;
  try {
    await connector.ready;
    const client = await openPhone(relay, adminToken);
    phone = client.socket;
    await client.request("sub.tasks", { boardId: "thinkbook-main" });
    const first = await client.wait((message) => message.type === "evt.snapshot");
    const rooms = first.payload?.workspaces;
    assert.ok(Array.isArray(rooms) && isRecord(rooms[0]) && rooms[0].isGit === true && rooms[0].path === "/home/me/src/app");

    const created = await client.request("cmd.create", {
      boardId: "thinkbook-main",
      idempotencyKey: "idem-worktree-1",
      title: "Fix login flake",
      prompt: "Investigate the flaky login test.",
      agent: "cursor",
      cwd: "/home/me/src/app",
      useGitWorktree: true,
    });
    assert.equal(created.payload?.stage, "executed");
    const again = await client.request("cmd.create", {
      boardId: "thinkbook-main",
      idempotencyKey: "idem-worktree-1",
      title: "Fix login flake",
      prompt: "Investigate the flaky login test.",
      agent: "cursor",
      cwd: "/home/me/src/app",
      useGitWorktree: true,
    });
    assert.equal(again.payload?.stage, "executed");
    const posts = board.requests.filter((request) => request.method === "POST" && request.path === "/api/tasks");
    assert.equal(posts.length, 1);
    assert.equal(isRecord(posts[0]?.body) ? posts[0]?.body.useGitWorktree : undefined, true);

    const task = created.payload?.task;
    const taskId = isRecord(task) && typeof task.id === "string" ? task.id : "";
    const firstSeq = first.payload?.seq;
    board.emit("task_delete", { type: "task_delete", taskIds: [taskId] });
    const afterDelete = await client.wait((message) => {
      if (message.type !== "evt.snapshot" || message.payload?.seq === firstSeq) return false;
      const kept = message.payload?.workspaces;
      return Array.isArray(kept) && isRecord(kept[0]) && kept[0].isGit === true && kept[0].id === "ws_app";
    });
    const tasks = afterDelete.payload?.tasks;
    assert.ok(Array.isArray(tasks) && tasks.every((item) => !isRecord(item) || item.id !== taskId));
  } finally {
    phone?.close();
    await connector.close();
    await board.close();
    await relay.close();
  }
});

async function openPhone(relay: StartedServer, adminToken: string): Promise<{ socket: WebSocket; inbox: Env[]; request: Phone["request"]; wait: Phone["wait"] }> {
  const created = await fetch(new URL("/auth/pair/create", relay.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ boardIds: ["thinkbook-main"] }),
  });
  const { pairCode } = (await created.json()) as { pairCode: string };
  const paired = await fetch(new URL("/auth/pair", relay.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode, deviceName: "connector-test" }),
  });
  const device = (await paired.json()) as { deviceToken: string };
  const socket = new WebSocket(relay.wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
  const phone = new Phone(socket);
  const hello = await phone.request("client.hello", { token: device.deviceToken, name: "connector-test" });
  assert.equal(hello.payload?.stage, "executed");
  return { socket, inbox: phone.inbox, request: phone.request.bind(phone), wait: phone.wait.bind(phone) };
}

class Phone {
  readonly inbox: Env[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.inbox.push(JSON.parse(data.toString()) as Env);
      for (const listener of this.listeners) listener();
    });
    this.socket = socket;
  }

  private readonly socket: WebSocket;

  request(type: string, payload: Record<string, unknown>): Promise<Env> {
    const id = crypto.randomUUID();
    this.socket.send(JSON.stringify({ v: 1, id, type, ts: Date.now(), payload }));
    return this.wait((message) => {
      if (message.payload?.ref !== id) return false;
      if (message.type === "err") return true;
      return message.type === "ack" && message.payload?.stage !== "accepted";
    });
  }

  wait(pred: (message: Env) => boolean, ms = 4_000): Promise<Env> {
    const existing = this.inbox.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onMessage);
        reject(new Error(`timed out; saw ${this.inbox.map((message) => message.type).join(",") || "nothing"}`));
      }, ms);
      const onMessage = () => {
        const found = this.inbox.find(pred);
        if (!found) return;
        clearTimeout(timer);
        this.listeners.delete(onMessage);
        resolve(found);
      };
      this.listeners.add(onMessage);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(httpUrl: string, pred: (health: { boardsOnline: number }) => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 4_000) {
    const response = await fetch(new URL("/health", httpUrl));
    const health = (await response.json()) as { boardsOnline: number };
    if (pred(health)) return;
    await delay(20);
  }
  throw new Error("timed out waiting for the board to register");
}
