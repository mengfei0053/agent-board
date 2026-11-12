import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SqlitePool, insertRows } from "./databaseAdapter.js";

function pool(t: TestContext) {
  const db = new SqlitePool(":memory:");
  t.after(() => db.end());
  return db;
}

test("SQLite binds repeated/out-of-order parameters and never executes parameter contents", async (t) => {
  const db = pool(t);
  await db.query("CREATE TABLE sample (id INTEGER PRIMARY KEY, text TEXT, at TEXT)");
  const text = "中文😀'; DROP TABLE sample; --";
  const at = new Date("2026-01-01T12:00:00.123Z");
  const inserted = await db.query("INSERT INTO sample (text, at) VALUES ($1, $2)", [text, at]);
  assert.equal(inserted.rowCount, 1);
  const result = await db.query("SELECT $2 AS second, $1 AS first, $1 AS repeated", [text, null]);
  assert.deepEqual(result.rows, [{ second: null, first: text, repeated: text }]);
  assert.deepEqual((await db.query("SELECT text, at FROM sample")).rows, [{ text, at: at.toISOString() }]);
  assert.equal((await db.query("DELETE FROM sample RETURNING id")).rowCount, 1);
  assert.equal((await db.query("DELETE FROM sample")).rowCount, 0);
  await db.query("CREATE TABLE broken_json (settings TEXT)");
  await db.query("INSERT INTO broken_json VALUES ($1)", ["not JSON"]);
  await assert.rejects(db.query("SELECT settings FROM broken_json"), /Invalid JSON in database column settings/);
});

test("SQLite leases serialize concurrent transactions and standalone queries", async (t) => {
  const db = pool(t);
  await db.query("CREATE TABLE sample (value TEXT)");
  const first = await db.connect();
  await first.query("BEGIN");
  await first.query("INSERT INTO sample VALUES ($1)", ["rollback"]);
  const order: string[] = [];
  const second = db.connect().then(async (client) => {
    try {
      order.push("second");
      await client.query("BEGIN");
      await client.query("INSERT INTO sample VALUES ($1)", ["committed"]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
  const third = db.query("SELECT value FROM sample").then((result) => {
    order.push("standalone");
    return result;
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  await first.query("ROLLBACK");
  first.release();
  first.release();
  await second;
  assert.deepEqual((await third).rows, [{ value: "committed" }]);
  assert.deepEqual(order, ["second", "standalone"]);
  await assert.rejects(first.query("SELECT 1"), /released/);
});

test("release rolls back unfinished transactions and bulk failures do not leak partial rows", async (t) => {
  const db = pool(t);
  await db.query("CREATE TABLE model_history (kind TEXT, model TEXT CHECK(model <> 'rejected'), last_used_at TEXT)");
  const client = await db.connect();
  await client.query("BEGIN");
  await insertRows(client, "model_history", ["kind", "model", "last_used_at"], [["pi", "uncommitted", null]]);
  client.release();
  assert.equal((await db.query("SELECT * FROM model_history")).rowCount, 0);
  const failed = await db.connect();
  try {
    await failed.query("BEGIN");
    const rows = Array.from({ length: 101 }, (_, index) => ["pi", index === 100 ? "rejected" : `m-${index}`, null]);
    await assert.rejects(insertRows(failed, "model_history", ["kind", "model", "last_used_at"], rows), /CHECK/);
    await failed.query("ROLLBACK");
  } finally {
    failed.release();
  }
  assert.equal((await db.query("SELECT * FROM model_history")).rowCount, 0);
  await assert.rejects(insertRows(db, "model_history", ["injected-column"], [["x"]]), /identifiers/);
});

test("file-backed SQLite retains JSON and Unicode after close/reopen and enables safety pragmas", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-board-adapter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "board.db");
  const db = new SqlitePool(filename);
  try {
    assert.deepEqual((await db.query("PRAGMA journal_mode")).rows, [{ journal_mode: "wal" }]);
    assert.deepEqual((await db.query("PRAGMA foreign_keys")).rows, [{ foreign_keys: 1 }]);
    assert.deepEqual((await db.query("PRAGMA busy_timeout")).rows, [{ timeout: 5000 }]);
    await db.query("CREATE TABLE sample (attachments TEXT, settings TEXT, thinking_efforts TEXT, worktree TEXT)");
    await db.query("INSERT INTO sample VALUES ($1, $2, $3, $4)", [JSON.stringify([{ name: "附件.txt" }]), "{}", '["high"]', null]);
  } finally {
    await db.end();
  }
  await assert.rejects(db.query("SELECT 1"), /closed/);
  const reopened = new SqlitePool(filename);
  try {
    assert.deepEqual((await reopened.query("SELECT * FROM sample")).rows, [{ attachments: [{ name: "附件.txt" }], settings: {}, thinking_efforts: ["high"], worktree: null }]);
  } finally {
    await reopened.end();
  }
});
