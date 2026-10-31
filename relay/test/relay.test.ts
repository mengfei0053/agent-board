import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startRelay } from "../src/server.js";
import { parseEnvelope, type Envelope } from "../src/protocol.js";

const SETUP = "setup-token-test";

test("pair code is single use and health counts online boards", async () => {
  const relay = await startRelay({ setupToken: SETUP });
  try {
    const health = await get(relay.port, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.boardsOnline, 0);

    const missing = await post(relay.port, "/auth/pair/create", {});
    assert.equal(missing.status, 401);

    const created = await post(relay.port, "/boards", { boardId: "thinkbook", label: "ThinkBook" }, SETUP);
    assert.equal(created.status, 201);
    const boardToken = created.json.boardToken as string;

    const pair = await post(relay.port, "/auth/pair/create", {}, boardToken);
    assert.equal(pair.status, 201);
    const code = pair.json.pairCode as string;

    const phone = await post(relay.port, "/auth/pair", { pairCode: code, deviceName: "Pixel" });
    assert.equal(phone.status, 200);
    assert.equal(phone.json.role, "phone");
    assert.deepEqual(phone.json.boardIds, ["thinkbook"]);
    const again = await post(relay.port, "/auth/pair", { pairCode: code, deviceName: "other" });
    assert.equal(again.status, 401);

    const ws = await open(relay.port);
    const hello = await rpc(ws, "client.hello", { token: phone.json.deviceToken, name: "Pixel" });
    assert.equal(hello.payload.stage, "executed");
    const listed = await rpc(ws, "board.list", {});
    const boards = listed.payload.boards as { boardId: string; online: boolean }[];
    assert.equal(boards[0]?.online, false);
    const offline = await rpc(ws, "cmd.create", {
      boardId: "thinkbook",
      idempotencyKey: "ph-key-ok",
      title: "secret title",
      prompt: "do not audit this prompt",
      agent: "pi",
      cwd: "/home/me/repo",
    });
    assert.equal(offline.type, "err");
    assert.equal(offline.payload.code, "board_offline");
    assert.equal(relay.store.findCommand("thinkbook", "ph-key-ok"), undefined);
    assert.equal(JSON.stringify(relay.store.audit).includes("do not audit"), false);
    ws.close();
  } finally {
    await relay.close();
  }
});

test("online board stores a command once and forwards the result", async () => {
  const relay = await startRelay({ setupToken: SETUP });
  try {
    const created = await post(relay.port, "/boards", { boardId: "thinkbook", label: "ThinkBook" }, SETUP);
    const boardToken = created.json.boardToken as string;
    const pair = await post(relay.port, "/auth/pair/create", {}, boardToken);
    const phone = await post(relay.port, "/auth/pair", { pairCode: pair.json.pairCode, deviceName: "Pixel" });

    const connector = await open(relay.port);
    const registered = await rpc(connector, "board.register", { token: boardToken, boardId: "thinkbook" });
    assert.equal(registered.payload.stage, "executed");
    const health = await get(relay.port, "/health");
    assert.equal(health.json.boardsOnline, 1);

    const phoneWs = await open(relay.port);
    await rpc(phoneWs, "client.hello", { token: phone.json.deviceToken, name: "Pixel" });
    await rpc(phoneWs, "sub.tasks", { boardId: "thinkbook" });
    const forbidden = await rpc(phoneWs, "cmd.stop", { boardId: "other", taskId: "t1", idempotencyKey: "ph-key-ok" });
    assert.equal(forbidden.payload.code, "forbidden");

    const pending = rpc(phoneWs, "cmd.create", {
      boardId: "thinkbook",
      idempotencyKey: "ph-key-ok",
      title: "Ship it",
      prompt: "prompt body",
      agent: "codex",
      cwd: "/src",
      useGitWorktree: true,
    });
    const forwarded = await connector.next();
    assert.equal(forwarded.type, "cmd.create");
    assert.equal(forwarded.payload.useGitWorktree, true);
    const accepted = await pending;
    assert.equal(accepted.payload.stage, "accepted");

    connector.send(JSON.stringify({
      v: 1,
      id: "c1",
      type: "cmd.result",
      ts: 1,
      payload: {
        idempotencyKey: "ph-key-ok",
        stage: "executed",
        task: { id: "t1", title: "Ship it", status: "running", updatedAt: 5 },
      },
    }));
    const done = await phoneWs.next();
    assert.equal(done.payload.stage, "executed");

    const replay = await rpc(phoneWs, "cmd.create", {
      boardId: "thinkbook",
      idempotencyKey: "ph-key-ok",
      title: "Ship it",
      prompt: "prompt body",
      agent: "codex",
      cwd: "/src",
    });
    assert.equal(replay.payload.stage, "executed");

    connector.send(JSON.stringify({
      v: 1,
      id: "e1",
      type: "evt.task.done",
      ts: 2,
      payload: { boardId: "thinkbook", eventId: "e1", taskId: "t1", status: "succeeded", title: "Ship it" },
    }));
    const event = await phoneWs.next();
    assert.equal(event.type, "evt.task.done");
    phoneWs.close();
    connector.close();
  } finally {
    await relay.close();
  }
});

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

async function post(port: number, path: string, body: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

function open(port: number): Promise<WebSocket & { next: (id?: string) => Promise<Envelope> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`) as WebSocket & { next: (id?: string) => Promise<Envelope> };
    const queue: Envelope[] = [];
    const waiters: { id?: string; resolve: (message: Envelope) => void }[] = [];
    ws.on("message", (data) => {
      const message = parseEnvelope(String(data));
      const index = waiters.findIndex((waiter) => !waiter.id || waiter.id === message.id);
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(message);
      else queue.push(message);
    });
    ws.next = (id?: string) =>
      new Promise((done) => {
        const index = queue.findIndex((message) => !id || message.id === id);
        if (index >= 0) done(queue.splice(index, 1)[0]!);
        else waiters.push({ id, resolve: done });
      });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function rpc(ws: WebSocket & { next: (id?: string) => Promise<Envelope> }, type: string, payload: Record<string, unknown>): Promise<Envelope> {
  const id = `m${Math.random().toString(16).slice(2)}`;
  const wait = ws.next(id);
  ws.send(JSON.stringify({ v: 1, id, type, ts: Date.now(), payload }));
  return wait;
}
