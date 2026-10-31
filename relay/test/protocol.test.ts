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
