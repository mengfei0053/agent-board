import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import { startServer, type StartedServer } from "../src/server.js";

const servers: StartedServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

test("admin pair create, refresh, and revoke stay out of health", async () => {
  const adminToken = "admin-http-token-value";
  const boardToken = "board-http-token-value";
  const server = await start({ adminToken, boardToken });

  const denied = await fetch(new URL("/auth/pair/create", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ boardIds: ["thinkbook-main"] }),
  });
  assert.equal(denied.status, 401);

  const createdResponse = await fetch(new URL("/auth/pair/create", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ boardIds: ["thinkbook-main"] }),
  });
  const created = (await createdResponse.json()) as { pairCode: string };
  assert.equal(createdResponse.status, 200);
  assert.ok(created.pairCode.startsWith("pc_"));

  const pairedResponse = await fetch(new URL("/auth/pair", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode: created.pairCode, deviceName: "pixel" }),
  });
  const paired = (await pairedResponse.json()) as { deviceId: string; deviceToken: string; role: string; boardIds: string[] };
  assert.equal(pairedResponse.status, 200);
  assert.equal(paired.role, "phone");
  assert.deepEqual(paired.boardIds, ["thinkbook-main"]);

  const reused = await fetch(new URL("/auth/pair", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode: created.pairCode, deviceName: "pixel" }),
  });
  assert.equal(reused.status, 401);

  const refreshedResponse = await fetch(new URL("/auth/refresh", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: paired.deviceToken }),
  });
  const refreshed = (await refreshedResponse.json()) as { deviceToken: string; deviceId: string };
  assert.equal(refreshedResponse.status, 200);
  assert.notEqual(refreshed.deviceToken, paired.deviceToken);

  const revoked = await fetch(new URL("/auth/revoke/device", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ deviceId: refreshed.deviceId }),
  });
  assert.equal(revoked.status, 200);
  const stale = await fetch(new URL("/auth/refresh", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: refreshed.deviceToken }),
  });
  assert.equal(stale.status, 401);

  const boardRevoke = await fetch(new URL("/auth/revoke/board", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ boardToken }),
  });
  assert.equal(boardRevoke.status, 200);

  const health = await (await fetch(new URL("/health", server.httpUrl))).text();
  assert.equal(health.includes(adminToken), false);
  assert.equal(health.includes(boardToken), false);
  assert.equal(health.includes(created.pairCode), false);
  assert.equal(health.includes(paired.deviceToken), false);
  assert.equal(health.includes(refreshed.deviceToken), false);
  assert.equal(health.includes("thinkbook-main"), false);
});

test("pair brute force is rejected with 429", async () => {
  const adminToken = "admin-brute-token-value";
  const server = await start({ adminToken, boardToken: "board-brute-token-value", pairAttemptLimit: 3 });
  const created = await fetch(new URL("/auth/pair/create", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ boardIds: ["thinkbook-main"] }),
  });
  const { pairCode } = (await created.json()) as { pairCode: string };
  for (let i = 0; i < 3; i += 1) {
    const response = await fetch(new URL("/auth/pair", server.httpUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairCode: `wrong-code-${i}`, deviceName: "pixel" }),
    });
    assert.equal(response.status, 401);
  }
  const blocked = await fetch(new URL("/auth/pair", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode, deviceName: "pixel" }),
  });
  assert.equal(blocked.status, 429);
});

test("refresh closes the idle socket that still holds the old device token", async () => {
  const adminToken = "admin-rotate-token-value";
  const boardToken = "board-rotate-token-value";
  const server = await start({ adminToken, boardToken });
  const board = new WebSocket(server.wsUrl);
  await opened(board);
  const registered = readNext(board);
  board.send(JSON.stringify({
    v: 1,
    id: "reg-rotate",
    type: "board.register",
    ts: Date.now(),
    payload: { boardId: "thinkbook-main", token: boardToken, label: "ThinkBook" },
  }));
  assert.equal((await registered).type, "ack");

  const created = await fetch(new URL("/auth/pair/create", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ boardIds: ["thinkbook-main"] }),
  });
  const { pairCode } = (await created.json()) as { pairCode: string };
  const pairedResponse = await fetch(new URL("/auth/pair", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode, deviceName: "pixel" }),
  });
  const paired = (await pairedResponse.json()) as { deviceToken: string };
  const phone = new WebSocket(server.wsUrl);
  await opened(phone);
  const hello = readNext(phone);
  phone.send(JSON.stringify({
    v: 1,
    id: "hello-rotate",
    type: "client.hello",
    ts: Date.now(),
    payload: { token: paired.deviceToken, name: "pixel" },
  }));
  assert.equal((await hello).type, "ack");
  const subscribed = readNext(phone);
  phone.send(JSON.stringify({
    v: 1,
    id: "sub-rotate",
    type: "sub.tasks",
    ts: Date.now(),
    payload: { boardId: "thinkbook-main" },
  }));
  assert.equal((await subscribed).type, "ack");

  const revoked = readNext(phone);
  const refreshedResponse = await fetch(new URL("/auth/refresh", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: paired.deviceToken }),
  });
  const refreshed = (await refreshedResponse.json()) as { deviceToken: string };
  assert.equal(refreshedResponse.status, 200);
  assert.equal((await revoked).payload?.code, "revoked");

  const phone2 = new WebSocket(server.wsUrl);
  await opened(phone2);
  const hello2 = readNext(phone2);
  phone2.send(JSON.stringify({
    v: 1,
    id: "hello-rotate-2",
    type: "client.hello",
    ts: Date.now(),
    payload: { token: refreshed.deviceToken, name: "pixel" },
  }));
  assert.equal((await hello2).type, "ack");
  const seen: Array<{ type?: string }> = [];
  phone2.on("message", (data) => {
    seen.push(JSON.parse(data.toString()) as { type?: string });
  });
  const staleSeen: Array<{ type?: string }> = [];
  phone.on("message", (data) => {
    staleSeen.push(JSON.parse(data.toString()) as { type?: string });
  });
  board.send(JSON.stringify({
    v: 1,
    id: "done-rotate",
    type: "evt.task.done",
    ts: Date.now(),
    payload: {
      boardId: "thinkbook-main",
      taskId: "task_01",
      status: "stopped",
      generation: 1,
      seq: 1,
      eventId: "done-rotate",
      title: "Fix login flake",
    },
  }));
  await delay(80);
  assert.equal(seen.some((message) => message.type === "evt.task.done"), true);
  assert.equal(staleSeen.some((message) => message.type === "evt.task.done"), false);
  board.close();
  phone.close();
  phone2.close();
});

test("websocket rejects a bad board token, a pre-hello frame, and a message flood", async () => {
  const server = await start({ adminToken: "admin-ws-token-value", boardToken: "board-ws-token-value", wsMessagesPerSec: 2 });
  const board = new WebSocket(server.wsUrl);
  await opened(board);
  const boardErr = readNext(board);
  board.send(JSON.stringify({
    v: 1,
    id: "reg-1",
    type: "board.register",
    ts: Date.now(),
    payload: { boardId: "thinkbook-main", token: "wrong" },
  }));
  assert.equal((await boardErr).payload?.code, "unauthorized");
  board.close();

  const phone = new WebSocket(server.wsUrl);
  await opened(phone);
  const early = readNext(phone);
  phone.send(JSON.stringify({ v: 1, id: "list-1", type: "board.list", ts: Date.now(), payload: {} }));
  assert.equal((await early).payload?.code, "unauthorized");
  phone.close();

  const flood = new WebSocket(server.wsUrl);
  await opened(flood);
  const frames: Array<{ payload?: { code?: string } }> = [];
  flood.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as { payload?: { code?: string } });
  });
  for (let i = 0; i < 4; i += 1) {
    flood.send(JSON.stringify({ v: 1, id: `flood-${i}`, type: "board.list", ts: Date.now(), payload: {} }));
  }
  await delay(80);
  assert.equal(frames.some((frame) => frame.payload?.code === "rate_limited"), true);
  flood.close();
});

async function start(options: { adminToken: string; boardToken: string; pairAttemptLimit?: number; wsMessagesPerSec?: number }): Promise<StartedServer> {
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    adminToken: options.adminToken,
    boardToken: options.boardToken,
    pairTtlMs: 60_000,
    tokenTtlMs: 60_000,
    pairAttemptLimit: options.pairAttemptLimit,
    wsMessagesPerSec: options.wsMessagesPerSec,
    log: () => {},
  });
  servers.push(server);
  return server;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
}

function readNext(socket: WebSocket): Promise<{ type: string; payload?: { code?: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a websocket frame")), 2_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as { type: string; payload?: { code?: string } });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
