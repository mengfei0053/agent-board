import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import { AuthStore } from "../src/auth.js";
import { SqliteAuthStore } from "../src/persistence.js";
import { startServer, type StartedServer } from "../src/server.js";
import { NOW, pairPhone } from "./support.js";

const servers: StartedServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

test("SQLite restores device sessions, scoped credentials and revocations without plaintext tokens", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-board-relay-auth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "relay.sqlite");
  const clock = { t: NOW };
  let auth = openAuth(databasePath, () => clock.t);
  t.after(() => auth.close());

  const created = auth.createPairCode(["thinkbook-main"]);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const unusedPair = auth.createPairCode(["thinkbook-main"]);
  assert.equal(unusedPair.ok, true);
  if (!unusedPair.ok) return;
  const paired = auth.pair(created.pairCode, "pixel", "ip");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  const issued = auth.issueBoardToken(["thinkbook-main"]);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  auth.noteBoard("thinkbook-main");
  assert.equal(auth.revokeBoardId("retired-board").ok, true);
  assert.equal(auth.verifyBoard("board-token-value", "thinkbook-main").ok, false);
  auth.close();

  const stored = readFileSync(databasePath, "utf8");
  for (const secret of [paired.deviceToken, issued.boardToken, created.pairCode, unusedPair.pairCode, "board-token-value"]) {
    assert.equal(stored.includes(secret), false);
  }

  auth = openAuth(databasePath, () => clock.t);
  assert.equal(auth.verifyDevice(paired.deviceToken)?.deviceName, "pixel");
  assert.equal(auth.verifyBoard(issued.boardToken, "thinkbook-main").ok, true);
  assert.equal(auth.verifyBoard("board-token-value", "thinkbook-main").ok, false);
  assert.equal(auth.verifyBoard(issued.boardToken, "retired-board").ok, false);
  assert.equal(auth.pair(unusedPair.pairCode, "other", "ip").ok, false);
  assert.equal(auth.adminState().boards.find((board) => board.boardId === "thinkbook-main")?.revoked, false);

  const refreshed = auth.refresh(paired.deviceToken);
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  auth.close();
  auth = openAuth(databasePath, () => clock.t);
  assert.equal(auth.verifyDevice(paired.deviceToken), null);
  assert.equal(auth.verifyDevice(refreshed.deviceToken)?.deviceId, paired.deviceId);

  clock.t += 365 * 86_400_000;
  assert.deepEqual(auth.verifyDevice(refreshed.deviceToken)?.boardIds, ["thinkbook-main"]);
  assert.equal(auth.revokeDevice(paired.deviceId), true);
  auth.close();
  auth = openAuth(databasePath, () => clock.t);
  assert.equal(auth.verifyDevice(refreshed.deviceToken), null);
  assert.equal(auth.verifyDevice(paired.deviceToken), null);
});

test("startup migrates only unexpired legacy devices and preserves their scope across restarts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-board-relay-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "relay.sqlite");
  let now = NOW;
  const original = openAuth(path, () => now);
  const live = pairPhone(original, ["allowed"]);
  const expired = pairPhone(original, ["another-board"]);
  const revoked = pairPhone(original, ["another-board"]);
  assert.equal(original.revokeDevice(revoked.deviceId), true);
  original.close();

  // Recreate a v1 snapshot just before the legacy live token's expiry.
  const db = new SqliteAuthStore(path);
  try {
    const snapshot = db.load();
    assert.ok(snapshot);
    for (const row of snapshot.devices) row.expiresAt = row.deviceId === live.deviceId ? now + 1 : now;
    db.save(snapshot);
  } finally {
    db.close();
  }

  for (const restartAt of [NOW, NOW + 1, NOW + 365 * 86_400_000]) {
    now = restartAt;
    const auth = openAuth(path, () => now);
    try {
      const session = auth.verifyDevice(live.deviceToken);
      assert.equal(session?.expiresAt, 0);
      assert.deepEqual(session?.boardIds, ["allowed"]);
      assert.deepEqual(auth.adminState().devices.map((device) => device.deviceId), [live.deviceId]);
      for (const unavailable of [expired, revoked]) {
        assert.equal(auth.verifyDevice(unavailable.deviceToken), null);
        assert.equal(auth.refresh(unavailable.deviceToken).ok, false);
      }
    } finally {
      auth.close();
    }
  }
});

test("server restart keeps phone access and known boards but resets online connection state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-board-relay-server-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "relay.sqlite");
  const adminToken = "admin-persistent-token-value";
  const boardToken = "board-persistent-token-value";
  const options = { adminToken, boardToken, databasePath, pairTtlMs: 60_000, log: () => {} };
  let server = await startServer(options);
  servers.push(server);

  const issuedResponse = await fetch(new URL("/auth/board/issue", server.httpUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ boardIds: ["thinkbook-main"] }),
  });
  const issued = await issuedResponse.json() as { boardToken: string };
  assert.equal(issuedResponse.status, 200);
  const createdResponse = await fetch(new URL("/auth/pair/create", server.httpUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ boardIds: ["thinkbook-main"] }),
  });
  const created = await createdResponse.json() as { pairCode: string };
  const pairedResponse = await fetch(new URL("/auth/pair", server.httpUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode: created.pairCode, deviceName: "pixel" }),
  });
  const paired = await pairedResponse.json() as { deviceId: string; deviceToken: string };
  assert.equal(pairedResponse.status, 200);
  const board = await openSocket(server.wsUrl);
  assert.equal((await exchange(board, "board.register", "register-before", {
    boardId: "thinkbook-main", token: issued.boardToken, label: "ThinkBook",
  })).type, "ack");
  board.close();

  await server.close();
  servers.length = 0;
  server = await startServer(options);
  servers.push(server);
  assert.deepEqual(await (await fetch(new URL("/health", server.httpUrl))).json(), {
    ok: true,
    service: "agent-board-relay",
    protocol: 1,
    uptimeSec: 0,
    boardsOnline: 0,
    phonesOnline: 0,
    pairedDevices: 1,
  });

  const adminStateResponse = await fetch(new URL("/api/admin/state", server.httpUrl), {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const adminState = await adminStateResponse.json() as {
    boards: Array<{ boardId: string; online: boolean; generation: number }>;
    devices: Array<{ deviceId: string; online: boolean }>;
  };
  const knownBoard = adminState.boards.find((board) => board.boardId === "thinkbook-main");
  assert.equal(knownBoard?.online, false);
  assert.equal(knownBoard?.generation, 0);
  assert.equal(adminState.devices.find((device) => device.deviceId === paired.deviceId)?.online, false);

  const phone = await openSocket(server.wsUrl);
  t.after(() => phone.close());
  assert.equal((await exchange(phone, "client.hello", "hello-after", { token: paired.deviceToken })).payload?.deviceId, paired.deviceId);
  const listed = await exchange(phone, "board.list", "list-after", {});
  assert.deepEqual(listed.payload?.boards, [{ boardId: "thinkbook-main", online: false }]);

  const staleBoard = await openSocket(server.wsUrl);
  t.after(() => staleBoard.close());
  assert.equal((await exchange(staleBoard, "board.register", "stale-after", {
    boardId: "thinkbook-main", token: boardToken,
  })).payload?.code, "unauthorized");
  const liveBoard = await openSocket(server.wsUrl);
  t.after(() => liveBoard.close());
  assert.equal((await exchange(liveBoard, "board.register", "live-after", {
    boardId: "thinkbook-main", token: issued.boardToken,
  })).type, "ack");
});

function openAuth(databasePath: string, now: () => number): AuthStore {
  return new AuthStore({
    adminToken: "admin-token-value",
    boardToken: "board-token-value",
    pairTtlMs: 60_000,
    now,
    persistence: new SqliteAuthStore(databasePath),
  });
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function exchange(socket: WebSocket, type: string, id: string, payload: Record<string, unknown>): Promise<{
  type?: string;
  payload?: { code?: string; deviceId?: string; boards?: unknown[] };
}> {
  const response = new Promise<{ type?: string; payload?: { code?: string; deviceId?: string; boards?: unknown[] } }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
  socket.send(JSON.stringify({ v: 1, id, type, ts: Date.now(), payload }));
  return response;
}
