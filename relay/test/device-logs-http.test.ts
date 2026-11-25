import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import type { Entry } from "../src/device-logs.js";

const upload = "/api/device/logs";
const listing = "/api/admin/device-logs";
const admin = "local-admin";
const board = "local-board";
const row = (): Entry => ({ id: randomUUID(), ts: 42, level: "info", event: "app_started" });

async function fixture(t: TestContext, unusableLogDb = false) {
  const dir = mkdtempSync(join(tmpdir(), "relay-log-http-"));
  const databasePath = join(dir, "pair.sqlite");
  if (unusableLogDb) mkdirSync(databasePath + ".device-logs.sqlite");
  let time = 1_700_000_000_000;
  const options = { adminToken: admin, boardToken: board, databasePath, now: () => time, log: () => {} };
  let server = await startServer(options);
  t.after(async () => { try { await server.close(); } finally { rmSync(dir, { recursive: true }); } });
  const call = (path: string, token?: string, body?: unknown, type = "application/json") => fetch(server.httpUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token && { authorization: `Bearer ${token}` }), "content-type": type },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function pair() {
    const created = await call("/auth/pair/create", admin, { boardIds: ["board"] });
    assert.equal(created.status, 200);
    const paired = await call("/auth/pair", undefined, { pairCode: (await created.json()).pairCode });
    assert.equal(paired.status, 200);
    return await paired.json() as { deviceId: string; deviceToken: string };
  }
  async function page(query = "") {
    const result = await call(listing + query, admin);
    assert.equal(result.status, 200);
    return await result.json() as { entries: (Entry & { deviceId: string; receivedAt: number })[]; nextCursor: string | null };
  }
  return { call, pair, page, databasePath, logPath: databasePath + ".device-logs.sqlite", get server() { return server; },
    advance: (ms: number) => { time += ms; }, restart: async () => { await server.close(); server = await startServer(options); } };
}

test("a broken diagnostics DB does not take the relay or pairing offline", async t => {
  const f = await fixture(t, true);
  const { deviceToken } = await f.pair();
  assert.equal((await f.call("/health")).status, 200);
  assert.equal((await f.call(listing, admin)).status, 503);
  assert.equal((await f.call(upload, deviceToken, { entries: [row()] })).status, 503);
});

test("device bearer, method, JSON type/size and closed schema are enforced before any insert", async t => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const good = row();
  const body = { entries: [good] };
  for (const token of [undefined, "not-a-session", admin, board]) {
    assert.equal((await f.call(upload, token, body)).status, 401);
  }
  assert.equal((await f.call(upload, deviceToken)).status, 405);
  assert.equal((await f.call(upload, deviceToken, body, "text/plain")).status, 415);
  assert.equal((await f.call(upload, deviceToken, "x".repeat(65536))).status, 413);
  const chunked = request(f.server.httpUrl + upload, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" } });
  const rejected = once(chunked, "response", { signal: AbortSignal.timeout(2000) });
  try {
    chunked.write(Buffer.alloc(65536, 32)); chunked.write("{");
    const [res] = await rejected; // Oversized streaming request need not finish first.
    assert.equal(res.statusCode, 413); res.resume();
  } finally { chunked.destroy(); }
  assert.equal((await f.call(upload + "?deviceId=other", deviceToken, body)).status, 400);
  for (const invalid of [null, [], {}, { entries: [] }, { entries: Array(51).fill(good) }, { ...body, deviceId: "other" },
    ...[{ deviceId: "other" }, { text: "private task" }, { message: "private URL" }, { token: "private key" },
      { event: "private task" }, { ts: -1 }, { ts: "42" }, { ts: 0.5 }, { ts: 2 ** 53 }, { id: "arbitrary text" },
      { level: "warn" }, { event: "command_failed" }, { op: "free text" }, { reason: "free text" }, { count: 65536 }].map(patch => ({ entries: [good, { ...good, ...patch }] })),
  ]) assert.equal((await f.call(upload, deviceToken, invalid)).status, 400);
  assert.deepEqual((await f.page()).entries, []);
  const result = await f.call(upload, deviceToken, body, "application/json; charset=utf-8");
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { acked: [good.id] });
});

test("only admins can page by receipt cursor, device and severity", async t => {
  const f = await fixture(t);
  const a = await f.pair(), b = await f.pair();
  // Deliberately equal client timestamps and receipt times. IDs are per-device.
  const shared = row(), err: Entry = { ...row(), level: "error", event: "command_timeout" }, last = row();
  assert.equal((await f.call(upload, a.deviceToken, { entries: [shared, err, last] })).status, 200);
  assert.equal((await f.call(upload, b.deviceToken, { entries: [shared] })).status, 200);
  for (const token of [undefined, a.deviceToken, board]) assert.equal((await f.call(listing, token)).status, 401);
  assert.equal((await f.call(listing, admin, {})).status, 405);
  for (const query of ["level=warn", "limit=101", "limit=0", "limit=1&limit=2", "before=-1", "before=1e3", "before=9007199254740992", "deviceId=", "text=query"]) {
    assert.equal((await f.call(listing + "?" + query, admin)).status, 400, query);
  }
  const first = await f.page("?limit=2");
  assert.deepEqual(first.entries.map(e => [e.id, e.deviceId]), [[shared.id, b.deviceId], [last.id, a.deviceId]]);
  assert.match(first.nextCursor!, /^\d+$/);
  assert.equal((await f.call(upload, a.deviceToken, { entries: [row()] })).status, 200);
  const second = await f.page("?limit=2&before=" + first.nextCursor);
  assert.deepEqual(second.entries.map(e => e.id), [err.id, shared.id]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await f.page(`?level=error&deviceId=${a.deviceId}`)).entries.map(e => e.id), [err.id]);
  assert.deepEqual((await f.page(`?level=info&deviceId=${b.deviceId}`)).entries, [{ ...shared, deviceId: b.deviceId, receivedAt: 1_700_000_000_000 }]);
});

test("ACK survives restart in a separate DB; retries/conflicts, rotation and revocation follow device identity", async t => {
  const f = await fixture(t);
  const a = await f.pair(), item = row();
  const body = { entries: [item, { ...item, id: item.id.toUpperCase() }] };
  const first = await f.call(upload, a.deviceToken, body);
  assert.deepEqual(await first.json(), { acked: [item.id] });
  for (const [file, expected, absent] of [[f.databasePath, "relay_auth_state", "device_logs"], [f.logPath, "device_logs", "relay_auth_state"]] as const) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      assert.ok(tables.includes(expected)); assert.ok(!tables.includes(absent));
      if (file === f.logPath) assert.equal(db.prepare("SELECT id FROM device_logs").get()?.id, item.id);
    } finally { db.close(); }
  }
  await f.restart();
  const retry = await f.call(upload, a.deviceToken, body);
  assert.deepEqual(await retry.json(), { acked: [item.id] });
  const conflict = await f.call(upload, a.deviceToken, { entries: [row(), { ...item, id: item.id.toUpperCase(), ts: 123 }] });
  assert.equal(conflict.status, 409);
  assert.deepEqual((await f.page()).entries.map(e => e.id), [item.id]);
  const rotated = await f.call("/auth/refresh", undefined, { deviceToken: a.deviceToken });
  const fresh = (await rotated.json()).deviceToken;
  assert.equal((await f.call(upload, a.deviceToken, body)).status, 401);
  assert.deepEqual(await (await f.call(upload, fresh, body)).json(), { acked: [item.id] });
  assert.equal((await f.call("/auth/revoke/device", admin, { deviceId: a.deviceId })).status, 200);
  await f.restart();
  assert.equal((await f.call(upload, fresh, body)).status, 401);
  assert.deepEqual((await f.page()).entries.map(e => e.id), [item.id]);
});

test("extended context participates in same-batch and committed conflicts; default count retries ACK", async t => {
  const f = await fixture(t);
  const { deviceToken, deviceId } = await f.pair();
  const item: Entry = { ...row(), event: "lookup_result", op: "lookup", reason: "executed" };
  const send = (...entries: Entry[]) => f.call(upload, deviceToken, { entries });
  const variants: Entry[] = [{ ...item, op: "detail" }, { ...item, reason: "accepted" }, { ...item, count: 2 },
    { ...item, op: undefined }, { ...item, reason: undefined }];
  for (const changed of variants) assert.equal((await send(item, changed)).status, 409);
  assert.deepEqual((await f.page()).entries, []);
  assert.deepEqual(await (await send(item, { ...item, count: 1 })).json(), { acked: [item.id] });
  await f.restart();
  assert.deepEqual(await (await send({ ...item, count: 1 })).json(), { acked: [item.id] });
  for (const changed of variants) assert.equal((await send(row(), changed)).status, 409);
  assert.deepEqual((await f.page()).entries, [{ ...item, receivedAt: 1_700_000_000_000, deviceId }]);
});

test("a SQLite COMMIT failure never becomes an HTTP ACK; the same batch can retry", async t => {
  const f = await fixture(t);
  const a = await f.pair(), item = row();
  const db = new DatabaseSync(f.logPath);
  try {
    db.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(pid REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON device_logs BEGIN INSERT INTO child VALUES (1); END;`);
    const send = () => f.call(upload, a.deviceToken, { entries: [item] });
    const failed = await send();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: { code: "internal", message: "internal error" } });
    assert.deepEqual((await f.page()).entries, []);
    db.exec("DROP TRIGGER fail_commit");
    assert.deepEqual(await (await send()).json(), { acked: [item.id] });
  } finally { db.close(); }
});

test("revocation while the request body is still arriving prevents a write", async t => {
  const f = await fixture(t);
  const a = await f.pair();
  const req = request(f.server.httpUrl + upload, { method: "POST", headers: { authorization: `Bearer ${a.deviceToken}`, "content-type": "application/json" } });
  const response = once(req, "response");
  req.write('{"entries":[');
  assert.equal((await f.call("/auth/revoke/device", admin, { deviceId: a.deviceId })).status, 200);
  req.end(JSON.stringify(row()) + "]}");
  const [res] = await response;
  res.resume(); assert.equal(res.statusCode, 401);
  assert.deepEqual((await f.page()).entries, []);
});

test("at the HTTP write limit new batches return 429 while exact retries still ACK", async t => {
  const f = await fixture(t);
  const a = await f.pair();
  const send = (item: Entry) => f.call(upload, a.deviceToken, { entries: [item] });
  const items = Array.from({ length: 31 }, () => ({ ...row(), count: 65535 }));
  for (const item of items.slice(0, 30)) assert.equal((await send(item)).status, 200);
  assert.equal((await send(items[30]!)).status, 429);
  assert.deepEqual(await (await send(items[0]!)).json(), { acked: [items[0]!.id] });
  f.advance(60_000);
  assert.equal((await send(items[30]!)).status, 200);
});

test("an outstanding SQLite write lock does not delay a WebSocket handshake or produce an early ACK", async t => {
  const f = await fixture(t);
  const a = await f.pair(), item = row();
  const db = new DatabaseSync(f.logPath);
  db.exec("BEGIN IMMEDIATE");
  // Saturation proves writes are actually pending before we exercise the WS path.
  // Retry one ID concurrently: accepted requests must ACK the same committed row.
  const sends = Array.from({ length: 33 }, () => f.call(upload, a.deviceToken, { entries: [item] }));
  let socket: WebSocket | undefined;
  try {
    assert.equal((await Promise.race(sends)).status, 429);
    socket = new WebSocket(f.server.wsUrl);
    await once(socket, "open", { signal: AbortSignal.timeout(2000) });
    const ack = once(socket, "message", { signal: AbortSignal.timeout(2000) });
    socket.send(JSON.stringify({ v: 1, id: "hello", type: "client.hello", ts: Date.now(), payload: { token: a.deviceToken } }));
    assert.equal(JSON.parse((await ack)[0].toString()).type, "ack");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_logs").get()?.n, 0);
  } finally { db.exec("ROLLBACK"); db.close(); socket?.terminate(); }
  const replies = await Promise.all(sends);
  assert.equal(replies.filter(r => r.status === 429).length, 1);
  for (const reply of replies.filter(r => r.status !== 429)) {
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { acked: [item.id] });
  }
  assert.deepEqual((await f.page()).entries.map(r => r.id), [item.id]);
});
