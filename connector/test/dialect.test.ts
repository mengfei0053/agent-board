import assert from "node:assert/strict";
import test from "node:test";
import { EventCursor } from "../src/cursor.js";
import { eventsFromBoardSse } from "../src/dialect.js";
import type { MappedTask } from "../src/map.js";

test("ThinkBook SSE names map onto relay events", () => {
  const cursor = new EventCursor("thinkbook-main");
  cursor.reset(1);
  const known = new Map<string, MappedTask>();
  const hello = eventsFromBoardSse(cursor, known, "hello", JSON.stringify({
    type: "hello",
    tasks: [{ id: "task_01", title: "Fix login flake", kind: "cursor", status: "running", updatedAt: 10 }],
    workspaces: [{ id: "ws_1" }],
  }));
  assert.deepEqual(hello.map((event) => event.type), ["evt.snapshot"]);
  const tasks = hello[0]?.payload.tasks;
  assert.ok(Array.isArray(tasks) && tasks.length === 1);
  assert.equal(isRecord(tasks[0]) ? tasks[0].agent : undefined, "cursor");

  assert.equal(eventsFromBoardSse(cursor, known, "ping", "{}").length, 0);
  const rooms = [{ id: "ws_1", name: "App", path: "/home/me/src/app", isGit: true }];
  const upsert = eventsFromBoardSse(cursor, known, "workspace_upsert", JSON.stringify({
    type: "workspace_upsert",
    workspace: { id: "ws_1", name: "App", path: "/home/me/src/app" },
  }), rooms);
  assert.equal(upsert[0]?.type, "evt.snapshot");
  assert.equal(Array.isArray(upsert[0]?.payload.tasks) ? upsert[0]?.payload.tasks.length : 0, 1);
  const listed = upsert[0]?.payload.workspaces;
  assert.ok(Array.isArray(listed) && isRecord(listed[0]) && listed[0].isGit === true);

  const log = eventsFromBoardSse(cursor, known, "task_log", JSON.stringify({
    type: "task_log",
    taskId: "task_01",
    line: "building",
    at: 11,
  }));
  assert.equal(log[0]?.type, "evt.log");
  assert.equal(log[0]?.payload.line, "building");
  assert.equal(log[0]?.payload.stream, "system");

  const done = eventsFromBoardSse(cursor, known, "task_upsert", JSON.stringify({
    type: "task_upsert",
    task: { id: "task_01", title: "Fix login flake", kind: "cursor", status: "succeeded", updatedAt: 12 },
  }));
  assert.deepEqual(done.map((event) => event.type), ["evt.task", "evt.task.done"]);
  const repeat = eventsFromBoardSse(cursor, known, "task_upsert", JSON.stringify({
    type: "task_upsert",
    task: { id: "task_01", title: "Fix login flake", kind: "cursor", status: "succeeded", updatedAt: 13 },
  }));
  assert.equal(repeat.length, 0);

  const removed = eventsFromBoardSse(cursor, known, "task_delete", JSON.stringify({
    type: "task_delete",
    taskIds: ["task_01"],
  }), rooms);
  assert.deepEqual(removed.map((event) => event.type), ["evt.snapshot"]);
  assert.deepEqual(removed[0]?.payload.tasks, []);
  assert.equal(Array.isArray(removed[0]?.payload.workspaces) ? removed[0]?.payload.workspaces.length : 0, 1);
  assert.equal(removed.some((event) => event.type === "evt.task.done"), false);
});

test("archiving a known task refreshes the snapshot and is not a completion", () => {
  const cursor = new EventCursor("thinkbook-main");
  cursor.reset(1);
  const known = new Map<string, MappedTask>();
  eventsFromBoardSse(cursor, known, "hello", JSON.stringify({
    type: "hello",
    tasks: [{ id: "task_01", title: "Fix login flake", kind: "cursor", status: "running", updatedAt: 10 }],
  }));
  const parked = eventsFromBoardSse(cursor, known, "task_upsert", JSON.stringify({
    type: "task_upsert",
    task: { id: "task_01", title: "Fix login flake", kind: "cursor", status: "archived", updatedAt: 14 },
  }));
  assert.equal(parked.some((event) => event.type === "evt.task.done"), false);
  assert.equal(parked[0]?.type, "evt.snapshot");
  assert.deepEqual(parked[0]?.payload.tasks, []);
  const again = eventsFromBoardSse(cursor, known, "task_upsert", JSON.stringify({
    type: "task_upsert",
    task: { id: "task_01", title: "Fix login flake", status: "archived", updatedAt: 15 },
  }));
  assert.equal(again.length, 0);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
