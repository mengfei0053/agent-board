import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestDb, stopTestDb } from "./harness.js";
import { closePool, databaseKind, ensureSchema, getPool } from "../../src/db.js";

before(async () => { await startTestDb(); await ensureSchema(); });
after(async () => { await closePool(); await stopTestDb(); });

const at = "2026-01-01T12:00:00.123Z";

test("schema upgrades old task/workspace columns, repeats safely, and backfills latest model history", async () => {
  const db = getPool();
  for (const [table, column] of [["tasks", "attachments"], ["tasks", "worktree"], ["tasks", "thinking_effort"], ["workspaces", "settings"], ["workspaces", "sort_order"]]) {
    await db.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  await ensureSchema();
  await db.query("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)", ["ws", "workspace", "/tmp/workspace", at, at]);
  for (const [id, timestamp] of [["older", "2025-01-01T00:00:00.000Z"], ["newer", at]]) {
    await db.query(`INSERT INTO tasks (id,title,kind,cwd,workspace_id,prompt,model,status,created_at,updated_at,attachments,worktree)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, "task", "pi", "/tmp/workspace", "ws", "prompt", " test-model ", "todo", timestamp, timestamp,
      JSON.stringify([{ name: "attachment.txt" }]), JSON.stringify({ owned: true, path: "/tmp/worktree" })]);
  }
  await ensureSchema();
  await ensureSchema();
  const history = await db.query<{ model: string; last_used_at: Date | string }>("SELECT model,last_used_at FROM model_history WHERE kind = $1", ["pi"]);
  assert.equal(history.rows[0].model, "test-model");
  assert.equal(new Date(history.rows[0].last_used_at).toISOString(), at);
  await db.query("UPDATE model_history SET last_used_at = $1", ["2027-01-01T00:00:00.000Z"]);
  await ensureSchema();
  const latest = await db.query<{ last_used_at: Date | string }>("SELECT last_used_at FROM model_history");
  assert.equal(new Date(latest.rows[0].last_used_at).getUTCFullYear(), 2027);
});

test("database closure/reopen preserves structured task, workspace and child records", async () => {
  const db = getPool();
  await db.query("UPDATE workspaces SET settings = $1, sort_order = $2 WHERE id = $3", [JSON.stringify({ skills: ["docs"] }), 3, "ws"]);
  await db.query("INSERT INTO task_outputs (task_id,iteration,text,at) VALUES ($1,$2,$3,$4)", ["newer", 1, "回答😀", at]);
  await db.query("INSERT INTO task_prompts (task_id,iteration,prompt,at) VALUES ($1,$2,$3,$4)", ["newer", 1, "继续", at]);
  await db.query("INSERT INTO task_logs (task_id,line) VALUES ($1,$2)", ["newer", "log"]);
  await db.query("INSERT INTO task_side_jobs (task_id,job_id,kind,title,status) VALUES ($1,$2,$3,$4,$5)", ["newer", "job", "agent", "child", "running"]);
  await db.query("INSERT INTO uploads (name,size) VALUES ($1,$2)", ["attachment.txt", 42]);
  await closePool();
  await ensureSchema();
  const reopened = getPool();
  const task = await reopened.query("SELECT attachments,worktree FROM tasks WHERE id = $1", ["newer"]);
  assert.deepEqual(task.rows[0].attachments, [{ name: "attachment.txt" }]);
  assert.deepEqual(task.rows[0].worktree, { owned: true, path: "/tmp/worktree" });
  assert.deepEqual((await reopened.query("SELECT settings,sort_order FROM workspaces WHERE id = $1", ["ws"])).rows,
    [{ settings: { skills: ["docs"] }, sort_order: 3 }]);
  assert.equal((await reopened.query("SELECT text FROM task_outputs")).rows[0].text, "回答😀");
  assert.equal((await reopened.query("SELECT prompt FROM task_prompts")).rows[0].prompt, "继续");
  assert.equal((await reopened.query("SELECT size FROM uploads")).rows[0].size, 42);
});

test("rollback is atomic and parent deletion cascades without deleting retained model history", async () => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE tasks SET title = $1 WHERE id = $2", ["must roll back", "newer"]);
    await assert.rejects(client.query("INSERT INTO task_logs (task_id,line) VALUES ($1,$2)", ["missing", "invalid"]));
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal((await getPool().query("SELECT title FROM tasks WHERE id = $1", ["newer"])).rows[0].title, "task");
  const deleted = await getPool().query("DELETE FROM tasks WHERE id = $1 RETURNING id", ["newer"]);
  assert.equal(deleted.rowCount, 1);
  for (const table of ["task_outputs", "task_prompts", "task_logs", "task_side_jobs"]) {
    assert.equal((await getPool().query(`SELECT * FROM ${table}`)).rowCount, 0);
  }
  assert.equal((await getPool().query("SELECT * FROM model_history")).rowCount, 1);
  assert.ok(["sqlite", "postgres"].includes(databaseKind()));
});
