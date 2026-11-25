import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeviceLogs, parseLogBatch, type Entry } from "../src/device-logs.js";

const start = 1_700_000_000_000;
const entry = (): Entry => ({ id: randomUUID(), ts: 1, level: "info", event: "app_started" });

test("only the enumerated events at their own severity are accepted", () => {
  for (const [level, events] of Object.entries({
    info: ["app_started", "relay_connected", "snapshot_synced", "command_sent", "command_executed", "board_online", "sync_waiting",
      "sync_recovered", "reconnecting", "lookup_result"],
    error: ["relay_disconnected", "auth_rejected", "sync_gap", "command_failed", "command_timeout", "board_offline", "board_unavailable",
      "network_failed", "protocol_invalid", "pair_failed", "storage_failed", "attachment_failed", "app_exit_abnormal", "notification_failed"],
  })) {
    for (const event of events) {
      const item = { ...entry(), event, level };
      assert.deepEqual(parseLogBatch({ entries: [item] }), [item]);
      assert.equal(parseLogBatch({ entries: [{ ...item, level: level === "info" ? "error" : "info" }] }), null);
    }
  }
});

test("only allowlisted context and integer occurrence counts fit the wire schema", () => {
  const base = entry();
  const parse = (patch: object) => parseLogBatch({ entries: [{ ...base, ...patch }] });
  for (const [key, values] of Object.entries({
    op: ["create", "continue", "stop", "steer", "lookup", "detail", "archive", "archive_list", "workspace_create", "workspace_delete",
      "workspace_get", "workspace_update", "settings_get", "settings_put", "pair", "refresh", "health", "connect", "board_list", "subscribe"],
    reason: ["dns", "tls", "timeout", "network", "unauthorized", "forbidden", "unsupported", "board_offline", "bad_request",
      "rate_limited", "not_found", "disconnected", "unknown", "accepted", "executed", "failed", "invalid", "storage", "too_large",
      "empty", "unreadable", "limit", "crash", "anr", "low_memory", "permission"],
    count: [1, 65535],
  })) for (const value of values) assert.deepEqual(parse({ [key]: value }), [{ ...base, [key]: value }]);
  for (const key of ["op", "reason"]) {
    for (const value of [null, {}, [], 1, true, "", "free text", "__proto__", "constructor"]) assert.equal(parse({ [key]: value }), null);
  }
  for (const count of [0, -1, 65536, 1.5, "2", null, true]) assert.equal(parse({ count }), null);
  assert.equal(parse({ op: "create", reason: "accepted", count: 3, message: "arbitrary text" }), null);
});

test("migration keeps old receipts, cursors and ACKs across extended writes and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-migration-"));
  const file = join(dir, "logs.sqlite");
  const old = entry();
  const extended: Entry = { ...entry(), level: "error", event: "notification_failed", op: "subscribe", reason: "permission", count: 65535 };
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(`CREATE TABLE device_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceId TEXT NOT NULL, id TEXT NOT NULL COLLATE NOCASE, ts INTEGER NOT NULL,
      level TEXT NOT NULL, event TEXT NOT NULL, receivedAt INTEGER NOT NULL, UNIQUE(deviceId, id))`);
    legacy.prepare("INSERT INTO device_logs VALUES (77, 'phone', ?, ?, ?, ?, ?)").run(old.id, old.ts, old.level, old.event, start);
  } finally { legacy.close(); }
  try {
    for (let open = 0; open < 2; open++) {
      const store = new DeviceLogs(file, () => start + 1);
      try {
        assert.deepEqual(store.append("phone", [{ ...old, count: 1 }]), [old.id]);
        assert.equal(store.append("phone", [{ ...old, count: 2 }]), "id_conflict");
        assert.deepEqual(store.append("phone", [extended]), [extended.id]);
        assert.deepEqual(store.list({ limit: 1 }), { entries: [{ ...extended, deviceId: "phone", receivedAt: start + 1 }], nextCursor: "78" });
        assert.deepEqual(store.list({ limit: 1, before: 78 }), { entries: [{ ...old, deviceId: "phone", receivedAt: start }], nextCursor: null });
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test("rate windows count committed new batches, not retries or rejected batches", (t) => {
  let now = start;
  const store = new DeviceLogs(undefined, () => now);
  t.after(() => store.close());
  const first = entry();
  for (let d = 0; d < 4; d++) {
    for (let i = 0; i < 30; i++) {
      const row = i === 0 ? first : entry();
      assert.deepEqual(store.append(`phone${d}`, [row, row]), [row.id]);
    }
    assert.equal(store.append(`phone${d}`, [first, entry()]), "rate_limited");
    assert.deepEqual(store.append(`phone${d}`, [first]), [first.id]);
  }
  assert.equal(store.append("fifth", [first]), "rate_limited");
  now += 59_999;
  assert.equal(store.append("fifth", [first]), "rate_limited");
  now++;
  assert.deepEqual(store.append("fifth", [first]), [first.id]);
});

test("failed COMMIT rolls back the entire batch and does not consume write quota", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-commit-"));
  const file = join(dir, "logs.sqlite");
  const store = new DeviceLogs(file, () => start);
  const probe = new DatabaseSync(file);
  try {
    // All INSERTs succeed; the deferred constraint fails specifically at COMMIT.
    probe.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(pid REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON device_logs BEGIN INSERT INTO child VALUES (1); END;`);
    const batch = [entry(), entry()];
    assert.throws(() => store.append("one", batch), /constraint/i);
    const count = () => probe.prepare("SELECT count(*) AS n FROM device_logs").get()!.n;
    assert.equal(count(), 0);
    probe.exec("DROP TRIGGER fail_commit");
    assert.deepEqual(store.append("one", batch), batch.map(row => row.id));
    assert.equal(count(), 2);
    for (let i = 1; i < 30; i++) assert.ok(Array.isArray(store.append("one", [entry()])));
    assert.equal(store.append("one", [entry()]), "rate_limited");
  } finally {
    probe.close(); store.close(); rmSync(dir, { recursive: true });
  }
});

test("retention evicts by receipt order at 1000/device and 10000 globally", (t) => {
  let now = start;
  const store = new DeviceLogs(undefined, () => now);
  t.after(() => store.close());
  const retained: { id: string; device: string }[] = [];
  for (let d = 0; d <= 10; d++) {
    now += 60_000;
    // Fill the first device past its cap, then add nine full devices and one final batch.
    const batches = d === 0 ? 21 : d === 10 ? 1 : 20;
    for (let b = 0; b < batches; b++) {
      const batch = Array.from({ length: 50 }, () => ({ ...entry(), count: 65535 }));
      assert.deepEqual(store.append(`phone${d}`, batch), batch.map(row => row.id));
      retained.push(...batch.map(({ id }) => ({ id, device: `phone${d}` })));
    }
    if (d === 0) {
      retained.splice(0, 50);
      assert.deepEqual(allRows("phone0"), retained.map(r => r.id).reverse());
    }
  }
  assert.deepEqual(allRows(), retained.slice(-10_000).reverse().map(r => r.id));

  function allRows(deviceId?: string): string[] {
    const ids: string[] = [];
    let before: number | undefined;
    do {
      const page = store.list({ limit: 100, deviceId, before });
      ids.push(...page.entries.map(row => row.id));
      before = page.nextCursor === null ? undefined : Number(page.nextCursor);
    } while (before !== undefined);
    return ids;
  }
});

test("seven-day TTL uses receipt time, including the exact boundary and idle/startup cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-expiry-"));
  const file = join(dir, "logs.sqlite");
  let now = start;
  let store = new DeviceLogs(file, () => now);
  const probe = new DatabaseSync(file);
  try {
    const row = { ...entry(), ts: Number.MAX_SAFE_INTEGER };
    store.append("one", [row]);
    now += 7 * 86_400_000 - 1;
    assert.deepEqual(store.append("one", [row]), [row.id]);
    assert.equal(store.list({ limit: 10 }).entries[0]?.receivedAt, start);
    now++;
    assert.deepEqual(store.list({ limit: 10 }).entries, []);
    store.pruneExpired();
    const count = () => probe.prepare("SELECT count(*) AS n FROM device_logs").get()!.n;
    assert.equal(count(), 0);
    store.append("one", [row]);
    store.close(); now += 7 * 86_400_000;
    store = new DeviceLogs(file, () => now);
    assert.equal(count(), 0);
  } finally {
    probe.close(); store.close(); rmSync(dir, { recursive: true });
  }
});
