import assert from "node:assert/strict";
import test from "node:test";
import { EventCursor } from "../src/cursor.js";
import { loadConnectorConfig } from "../src/config.js";
import { buildCreateBody, mapBoardTask, mapStatus } from "../src/map.js";
import { demoteWorkspaces } from "../src/workspaces.js";

test("agent and cwd are required before any local create", () => {
  const missing = buildCreateBody({
    idempotencyKey: "idem-create-1",
    title: "Fix login flake",
    prompt: "look at the test",
    agent: "cursor",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "cwd_required");

  const unknown = buildCreateBody({
    idempotencyKey: "idem-create-1",
    title: "Fix login flake",
    prompt: "look at the test",
    agent: "gpt",
    cwd: "/home/me/src/app",
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "unknown_agent");

  const ok = buildCreateBody({
    idempotencyKey: "idem-create-1",
    title: "Fix login flake",
    prompt: "look at the test",
    agent: "cursor",
    cwd: "/home/me/src/app",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.body.kind, "cursor");
    assert.equal(ok.body.start, true);
    assert.equal(ok.body.cwd, "/home/me/src/app");
    assert.equal(ok.body.useGitWorktree, undefined);
  }

  const flagged = buildCreateBody({
    idempotencyKey: "idem-create-1",
    title: "Fix login flake",
    prompt: "look at the test",
    agent: "cursor",
    cwd: "/home/me/src/app",
    useGitWorktree: true,
  });
  assert.equal(flagged.ok, true);
  if (flagged.ok) assert.equal(flagged.body.useGitWorktree, true);

  const off = buildCreateBody({
    idempotencyKey: "idem-create-1",
    title: "Fix login flake",
    prompt: "look at the test",
    agent: "cursor",
    cwd: "/home/me/src/app",
    useGitWorktree: false,
  });
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.body.useGitWorktree, undefined);

  const junk = buildCreateBody({
    idempotencyKey: "idem-create-1",
    title: "Fix login flake",
    prompt: "look at the test",
    agent: "cursor",
    cwd: "/home/me/src/app",
    useGitWorktree: "true",
  });
  assert.equal(junk.ok, false);
  if (!junk.ok) assert.equal(junk.code, "bad_request");
});

test("archived is not a completion and blocked maps to paused", () => {
  assert.equal(mapStatus("blocked"), "paused");
  assert.equal(mapStatus("draft"), "queued");
  assert.equal(mapStatus("archived"), null);
  assert.equal(mapBoardTask({ id: "task_01", title: "Old", status: "archived", updatedAt: 1 }), null);
});

test("a title change with the same status emits evt.task and not done", () => {
  const cursor = new EventCursor("thinkbook-main");
  cursor.reset(1);
  const started = cursor.observe({ id: "task_01", title: "Fix", status: "running", updatedAt: 1, agent: "cursor" });
  assert.deepEqual(started.map((event) => event.type), ["evt.task"]);
  const renamed = cursor.observe({ id: "task_01", title: "Fix login flake", status: "running", updatedAt: 2, agent: "cursor" });
  assert.deepEqual(renamed.map((event) => event.type), ["evt.task"]);
  assert.equal(isRecord(renamed[0]?.payload.task) ? renamed[0]?.payload.task.title : undefined, "Fix login flake");
  const done = cursor.observe({ id: "task_01", title: "Fix login flake", status: "succeeded", updatedAt: 3, agent: "cursor" });
  assert.deepEqual(done.map((event) => event.type), ["evt.task", "evt.task.done"]);
  const repeat = cursor.observe({ id: "task_01", title: "Fix login flake", status: "succeeded", updatedAt: 4, agent: "cursor" });
  assert.equal(repeat.length, 0);
});

test("evt.task.done is emitted once on the first terminal transition", () => {
  const cursor = new EventCursor("thinkbook-main");
  cursor.reset(3);
  const snap = cursor.snapshot([{ id: "task_old", title: "Already done", status: "succeeded", updatedAt: 5 }], 10);
  assert.equal(snap.payload.generation, 3);
  assert.equal(snap.payload.seq, 1);
  assert.equal(snap.payload.version, 1);
  assert.equal(cursor.observe({ id: "task_old", title: "Already done", status: "succeeded", updatedAt: 6 }).length, 0);

  const running = cursor.observe({ id: "task_01", title: "Fix", status: "running", updatedAt: 7 });
  assert.deepEqual(running.map((event) => event.type), ["evt.task"]);
  const done = cursor.observe({ id: "task_01", title: "Fix", status: "stopped", updatedAt: 8 });
  assert.deepEqual(done.map((event) => event.type), ["evt.task", "evt.task.done"]);
  assert.equal(done[1]?.payload.status, "stopped");
  assert.equal(done[1]?.payload.taskId, "task_01");
  assert.equal(done[1]?.payload.generation, 3);
  const again = cursor.observe({ id: "task_01", title: "Fix", status: "stopped", updatedAt: 9 });
  assert.equal(again.length, 0);
  const renamed = cursor.observe({ id: "task_01", title: "Renamed", status: "stopped", updatedAt: 10 });
  assert.deepEqual(renamed.map((event) => event.type), ["evt.task"]);
  assert.equal(renamed.some((event) => event.type === "evt.task.done"), false);
  assert.equal(done[0]?.payload.seq, 3);
  assert.equal(done[1]?.payload.seq, 4);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("a failed workspace refresh does not keep isGit", () => {
  const next = demoteWorkspaces([{ id: "ws_app", name: "App", path: "/home/me/src/app", isGit: true }]);
  assert.equal(next[0]?.isGit, false);
  assert.equal(next[0]?.path, "/home/me/src/app");
});

test("board base URL must stay on loopback", () => {
  const remote = loadConnectorConfig({
    RELAY_WS_URL: "ws://127.0.0.1:8787/v1/ws",
    BOARD_ID: "thinkbook-main",
    BOARD_TOKEN: "board-token",
    BOARD_BASE_URL: "http://101.36.111.17:8791",
  });
  assert.equal(remote.ok, false);
  const local = loadConnectorConfig({
    RELAY_WS_URL: "ws://127.0.0.1:8787/v1/ws",
    BOARD_ID: "thinkbook-main",
    BOARD_TOKEN: "board-token",
  });
  assert.equal(local.ok, true);
  if (local.ok) assert.equal(local.config.boardBaseUrl, "http://127.0.0.1:8791");
});
