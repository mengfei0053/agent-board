import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMessage } from "../src/protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("cmd.create keeps idempotency fields and drops unknown ones", () => {
  const parsed = parseMessage({
    v: 1,
    id: "phone-create-1",
    type: "cmd.create",
    ts: 1761890000000,
    payload: {
      boardId: "thinkbook-main",
      idempotencyKey: "android-req-7f3a",
      title: "Fix login flake",
      prompt: "Investigate the flaky login test and propose a fix.",
      agent: "cursor",
      cwd: "/home/me/src/app",
      note: "ignore me",
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== "cmd.create") return;
  assert.equal(parsed.idempotencyKey, "android-req-7f3a");
  assert.equal(parsed.envelope.payload?.note, undefined);
});

test("evt.task.done requires the terminal cursor fields", () => {
  const stopped = parseMessage(done("stopped"));
  assert.equal(stopped.ok, true);
  if (!stopped.ok || stopped.kind !== "evt.task.done") return;
  assert.equal(stopped.taskId, "task_01");
  assert.equal(stopped.generation, 1);
  assert.equal(stopped.seq, 4);
  assert.equal(stopped.eventId, "board-done-1");

  for (const status of ["queued", "running", "paused"]) {
    const parsed = parseMessage(done(status));
    assert.equal(parsed.ok, false, status);
  }
});

test("malformed envelopes are rejected", () => {
  assert.equal(parseMessage("{").ok, false);
  const version = parseMessage({ v: 2, id: "x", type: "board.list", ts: 1 });
  assert.equal(version.ok, false);
  if (!version.ok) assert.equal(version.code, "bad_version");
  const missing = parseMessage({
    v: 1,
    id: "phone-create-1",
    type: "cmd.create",
    ts: 1,
    payload: { boardId: "thinkbook-main", title: "t", prompt: "p" },
  });
  assert.equal(missing.ok, false);
});

test("task workspaceId is optional and forwarded", () => {
  const withId = parseMessage(frame("evt.task", "task-ws", {
    boardId: "thinkbook-main",
    generation: 1,
    seq: 2,
    eventId: "task-ws",
    task: { id: "task_01", title: "Fix login flake", status: "running", updatedAt: 10, agent: "cursor", workspaceId: "ws_app", note: "drop" },
  }));
  assert.equal(withId.ok, true);
  if (!withId.ok || withId.kind !== "evt.task") return;
  const task = withId.envelope.payload?.task as { workspaceId?: string; note?: string };
  assert.equal(task.workspaceId, "ws_app");
  assert.equal(task.note, undefined);

  const omitted = parseMessage(frame("evt.snapshot", "snap-old", {
    boardId: "thinkbook-main",
    generation: 1,
    seq: 1,
    eventId: "snap-old",
    version: 1,
    capturedAt: 10,
    tasks: [{ id: "task_01", title: "Fix login flake", status: "queued", updatedAt: 10 }],
  }));
  assert.equal(omitted.ok, true);
  if (!omitted.ok || omitted.kind !== "evt.snapshot") return;
  const rows = omitted.envelope.payload?.tasks as Array<{ workspaceId?: string }>;
  assert.equal(rows[0]?.workspaceId, undefined);

  const bad = parseMessage(frame("evt.task", "task-bad-ws", {
    boardId: "thinkbook-main",
    generation: 1,
    seq: 2,
    eventId: "task-bad-ws",
    task: { id: "task_01", title: "Fix login flake", status: "running", updatedAt: 10, workspaceId: "nope id" },
  }));
  assert.equal(bad.ok, false);
});

test("workspace commands keep their fields and drop unknown ones", () => {
  const created = parseMessage(frame("cmd.workspace.create", "ws-new", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    name: " App ",
    path: "/home/me/src/app",
    note: "ignore",
  }));
  assert.equal(created.ok, true);
  if (!created.ok || created.kind !== "cmd.workspace.create") return;
  assert.equal(created.envelope.payload?.name, "App");
  assert.equal(created.envelope.payload?.path, "/home/me/src/app");
  assert.equal(created.envelope.payload?.note, undefined);

  const relative = parseMessage(frame("cmd.workspace.create", "ws-rel", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    name: "App",
    path: "relative",
  }));
  assert.equal(relative.ok, false);

  const removed = parseMessage(frame("cmd.workspace.delete", "ws-del", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-del-1",
    workspaceId: "_nanoid01",
    note: "ignore",
  }));
  assert.equal(removed.ok, true);
  if (!removed.ok || removed.kind !== "cmd.workspace.delete") return;
  assert.equal(removed.envelope.payload?.workspaceId, "_nanoid01");
  assert.equal(removed.envelope.payload?.note, undefined);

  const lookup = parseMessage(frame("cmd.lookup", "ws-look", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    cmd: "cmd.workspace.create",
  }));
  assert.equal(lookup.ok, true);

  const ack = parseMessage(frame("ack", "ack-ws", {
    ref: "phone-ws-create-1",
    stage: "executed",
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    commandId: "cmd-ws-1",
    workspace: { id: "ws_app", name: "App", path: "/home/me/src/app", isGit: true },
    extra: true,
  }));
  assert.equal(ack.ok, true);
  if (!ack.ok || ack.kind !== "ack") return;
  assert.equal((ack.envelope.payload?.workspace as { id: string }).id, "ws_app");
  assert.equal(ack.envelope.payload?.extra, undefined);
});

function frame(type: string, id: string, payload: Record<string, unknown>) {
  return { v: 1, id, type, ts: 1761890000000, payload };
}

test("PROTOCOL.md websocket examples parse", () => {
  const text = readFileSync(path.join(root, "PROTOCOL.md"), "utf8");
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)];
  assert.ok(blocks.length >= 8);
  let checked = 0;
  for (const block of blocks) {
    const value = JSON.parse(block[1] ?? "") as { v?: number; type?: string };
    if (value.v !== 1 || typeof value.type !== "string") continue;
    const parsed = parseMessage(value);
    assert.equal(parsed.ok, true, parsed.ok ? value.type : `${value.type}: ${parsed.message}`);
    checked += 1;
  }
  assert.ok(checked >= 8);
});

function done(status: string) {
  return {
    v: 1,
    id: "board-done-1",
    type: "evt.task.done",
    ts: 1761890005000,
    payload: {
      boardId: "thinkbook-main",
      taskId: "task_01",
      status,
      generation: 1,
      seq: 4,
      eventId: "board-done-1",
      title: "Fix login flake",
      summary: "Stopped by client",
    },
  };
}
