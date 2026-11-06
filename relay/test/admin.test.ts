import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "../src/server.js";
import { frame, helloPhone, pairPhone, registerBoard, setup } from "./support.js";

const adminToken = "admin-management-test-token";
const boardToken = "board-management-test-token";

test("admin metadata lists offline, revoked and scoped boards without sharing mutable state or secrets", () => {
  const { auth, hub, peer, clock } = setup();
  const board = registerBoard(hub, peer());
  const phonePeer = peer();
  const paired = pairPhone(auth, ["thinkbook-main"], "<img src=x onerror=alert(1)>");
  const phone = { conn: hub.attachPhone(phonePeer.send, phonePeer.close), token: paired.deviceToken, deviceId: paired.deviceId };
  hub.handlePhone(phone.conn, frame("client.hello", "safe-hello-id", { token: phone.token }));
  const idle = pairPhone(auth, ["offline-board"], "offline phone");
  const pending = auth.createPairCode(["pending-board"]);
  assert.ok(pending.ok);
  assert.ok(auth.issueBoardToken(["issued-board"]).ok);
  auth.revokeBoardId("revoked-board");

  const state = hub.adminState();
  assert.equal(state.activePairCodes, 1);
  assert.equal(state.boards.find((item) => item.boardId === "thinkbook-main")?.online, true);
  assert.equal(state.boards.find((item) => item.boardId === "thinkbook-main")?.connectedAt, clock.t);
  assert.equal(state.boards.find((item) => item.boardId === "offline-board")?.online, false);
  assert.equal(state.boards.find((item) => item.boardId === "revoked-board")?.revoked, true);
  assert.equal(state.boards.find((item) => item.boardId === "issued-board")?.credentialActive, true);
  const device = state.devices.find((item) => item.deviceId === phone.deviceId)!;
  assert.equal(device.online, true);
  assert.equal(device.connections, 1);
  assert.equal(device.deviceName, "<img src=x onerror=alert(1)>");
  assert.equal(state.devices.find((item) => item.deviceId === idle.deviceId)?.online, false);
  const serialized = JSON.stringify(state);
  for (const secret of [phone.token, idle.deviceToken, pending.pairCode, "admin-token-value", "board-token-value"]) {
    assert.equal(serialized.includes(secret), false);
  }
  device.boardIds.push("injected");
  assert.equal(auth.verifyDevice(phone.token)?.boardIds.includes("injected"), false);

  const second = hub.attachPhone(peer().send, () => {});
  hub.handlePhone(second, frame("client.hello", "second", { token: phone.token }));
  assert.equal(hub.adminState().devices.find((item) => item.deviceId === phone.deviceId)?.connections, 2);
  hub.disconnectPhone(second);
  hub.disconnectPhone(phone.conn);
  hub.disconnectBoard(board);
  assert.equal(hub.adminState().devices.every((item) => !item.online), true);
  assert.equal(hub.adminState().boards.find((item) => item.boardId === "thinkbook-main")?.online, false);
  clock.t += 60_001;
  assert.equal(hub.adminState().devices.length, 0);
  assert.equal(hub.adminState().activePairCodes, 0);
  hub.dispose();
});

test("expired connected sessions and revoked devices disappear from admin metadata", () => {
  const { auth, hub, peer, clock } = setup({ tokenTtlMs: 1_000 });
  const phone = helloPhone(hub, auth, peer());
  const other = helloPhone(hub, auth, peer(), "other");
  assert.ok(auth.revokeDevice(other.deviceId));
  hub.kickDevice(other.deviceId);
  assert.equal(hub.adminState().devices.length, 1);
  clock.t += 1_001;
  assert.equal(hub.adminState().devices.length, 0);
  assert.equal(auth.verifyDevice(phone.token), null);
  hub.dispose();
});

test("admin assets have restrictive security headers and no embedded credentials", async (t) => {
  const server = await startServer({ adminToken, boardToken, log: () => {} });
  t.after(() => server.close());
  for (const path of ["/admin", "/admin/", "/admin/admin.js", "/admin/admin.css"]) {
    const response = await fetch(server.httpUrl + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const body = await response.text();
    assert.equal(body.includes(adminToken), false);
    assert.equal(body.includes(boardToken), false);
  }
  const head = await fetch(server.httpUrl + "/admin", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(server.httpUrl + "/admin", { method: "POST" })).status, 405);
  assert.equal((await fetch(server.httpUrl + "/admin/../src/auth.ts")).status, 404);
});

test("admin state requires ADMIN_TOKEN, shares rate limits, and excludes credentials", async (t) => {
  const server = await startServer({ adminToken, boardToken, log: () => {} });
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
  const getState = (token?: string) => fetch(server.httpUrl + "/api/admin/state", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  assert.equal((await getState()).status, 401);
  assert.equal((await getState(boardToken)).status, 401);
  assert.equal((await getState("wrong")).status, 401);
  assert.equal((await fetch(server.httpUrl + "/api/admin/state", { method: "POST", headers })).status, 405);
  const initial = await getState(adminToken);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual((await initial.json() as { devices: unknown[] }).devices, []);

  const created = await fetch(server.httpUrl + "/auth/pair/create", {
    method: "POST", headers, body: JSON.stringify({ boardIds: ["offline-board"] }),
  });
  const { pairCode } = await created.json() as { pairCode: string };
  const paired = await fetch(server.httpUrl + "/auth/pair", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode, deviceName: "pixel" }),
  });
  const { deviceId, deviceToken } = await paired.json() as { deviceId: string; deviceToken: string };
  assert.equal((await getState(deviceToken)).status, 401);
  const response = await getState(adminToken);
  const raw = await response.text();
  const state = JSON.parse(raw);
  assert.equal(state.devices[0].deviceId, deviceId);
  assert.equal(state.devices[0].online, false);
  assert.equal(state.boards[0].boardId, "offline-board");
  for (const secret of [adminToken, boardToken, pairCode, deviceToken]) assert.equal(raw.includes(secret), false);
  const revoked = await fetch(server.httpUrl + "/auth/revoke/device", {
    method: "POST", headers, body: JSON.stringify({ deviceId }),
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await (await getState(adminToken)).json() as { devices: unknown[] }).devices, []);
  const health = await (await fetch(server.httpUrl + "/health")).text();
  assert.equal(health.includes("offline-board"), false);
  assert.equal(health.includes(deviceId), false);

  let blocked = false;
  for (let index = 0; index < 60; index++) {
    if ((await getState("wrong")).status === 429) { blocked = true; break; }
  }
  assert.equal(blocked, true);
  assert.equal((await getState(adminToken)).status, 429);
  assert.equal((await fetch(server.httpUrl + "/auth/pair/create", {
    method: "POST", headers, body: JSON.stringify({ boardIds: ["another"] }),
  })).status, 429);
});

test("adding a board with rotate=false keeps other boards' credentials and lists the new board", async (t) => {
  const server = await startServer({ adminToken, boardToken, log: () => {} });
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
  const issue = (body: unknown) => fetch(server.httpUrl + "/auth/board/issue", { method: "POST", headers, body: JSON.stringify(body) });

  assert.equal((await issue({ boardIds: ["new-board"], rotate: "no" })).status, 400);
  const added = await issue({ boardIds: ["new-board"], rotate: false });
  assert.equal(added.status, 200);
  const body = await added.json() as { boardToken: string; rotated: boolean };
  assert.equal(body.rotated, false);

  const state = await (await fetch(server.httpUrl + "/api/admin/state", { headers })).json() as {
    boards: { boardId: string; credentialActive: boolean; online: boolean }[];
  };
  assert.deepEqual(state.boards.map((b) => [b.boardId, b.credentialActive, b.online]), [["new-board", true, false]]);

  // The bootstrap token is still valid for other boards (not revoked).
  const other = await issue({ boardIds: ["other-board"], rotate: false });
  assert.equal(other.status, 200);
  const rotated = await (await issue({ boardIds: ["new-board"] })).json() as { rotated: boolean };
  assert.equal(rotated.rotated, true);
});
