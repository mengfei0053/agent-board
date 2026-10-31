import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage } from "../src/protocol.js";
import { cursor, frame, helloPhone, registerBoard, setup, task } from "./support.js";

const createBase = {
  boardId: "thinkbook-main",
  idempotencyKey: "android-req-7f3a",
  title: "Fix login flake",
  prompt: "Investigate the flaky login test.",
  agent: "cursor",
  cwd: "/home/me/src/app",
};

test("cmd.create forwards useGitWorktree only when it is true", () => {
  const omitted = parseMessage(frame("cmd.create", "c-omit", createBase));
  assert.equal(omitted.ok, true);
  if (omitted.ok) assert.equal(omitted.envelope.payload?.useGitWorktree, undefined);

  const off = parseMessage(frame("cmd.create", "c-off", { ...createBase, useGitWorktree: false }));
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.envelope.payload?.useGitWorktree, undefined);

  const on = parseMessage(frame("cmd.create", "c-on", { ...createBase, useGitWorktree: true }));
  assert.equal(on.ok, true);
  if (on.ok) assert.equal(on.envelope.payload?.useGitWorktree, true);

  const junk = parseMessage(frame("cmd.create", "c-junk", { ...createBase, useGitWorktree: "true" }));
  assert.equal(junk.ok, false);
  if (!junk.ok) assert.equal(junk.code, "bad_request");
});

test("evt.snapshot keeps a thin workspace list and rejects a bad row", () => {
  const base = {
    ...cursor(1, "snap-1"),
    version: 1,
    capturedAt: 1_700_000_000_000,
    tasks: [task()],
  };
  const plain = parseMessage(frame("evt.snapshot", "snap-plain", base));
  assert.equal(plain.ok, true);
  if (plain.ok) assert.equal(plain.envelope.payload?.workspaces, undefined);

  const withRooms = parseMessage(frame("evt.snapshot", "snap-ws", {
    ...base,
    eventId: "snap-ws",
    workspaces: [{ id: "ws_app", name: "App", path: "/home/me/src/app", isGit: true }],
  }));
  assert.equal(withRooms.ok, true);
  if (withRooms.ok) {
    const rows = withRooms.envelope.payload?.workspaces;
    assert.ok(Array.isArray(rows) && rows.length === 1);
    assert.equal(isRecord(rows[0]) ? rows[0].isGit : undefined, true);
    assert.equal(isRecord(rows[0]) ? rows[0].path : undefined, "/home/me/src/app");
  }

  const empty = parseMessage(frame("evt.snapshot", "snap-empty", { ...base, eventId: "snap-empty", workspaces: [] }));
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.envelope.payload?.workspaces, []);

  const bad = parseMessage(frame("evt.snapshot", "snap-bad", {
    ...base,
    eventId: "snap-bad",
    workspaces: [{ id: "ws_app", name: "App", path: "/home/me/src/app", isGit: "yes" }],
  }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "bad_request");
});

test("a relay hop keeps useGitWorktree and snapshot workspaces", () => {
  const fx = setup();
  const boardPeer = fx.peer();
  const phonePeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-wt", { ...createBase, useGitWorktree: true }));
  const forwarded = boardPeer.ofType("cmd.create").at(-1);
  assert.equal(forwarded?.payload?.useGitWorktree, true);
  assert.equal(forwarded?.payload?.cwd, "/home/me/src/app");

  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-plain", { ...createBase, idempotencyKey: "android-req-plain" }));
  assert.equal(boardPeer.ofType("cmd.create").at(-1)?.payload?.useGitWorktree, undefined);

  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-bad", { ...createBase, idempotencyKey: "android-req-bad", useGitWorktree: 1 }));
  assert.equal(phonePeer.ofType("err").at(-1)?.payload?.code, "bad_request");
  assert.equal(boardPeer.ofType("cmd.create").length, 2);

  fx.hub.handlePhone(phone.conn, frame("sub.tasks", "sub-1", { boardId: "thinkbook-main" }));
  fx.hub.handleBoard(board, frame("evt.snapshot", "snap-hop", {
    ...cursor(1, "snap-hop"),
    version: 1,
    capturedAt: 1_700_000_000_000,
    tasks: [task()],
    workspaces: [{ id: "ws_app", name: "App", path: "/home/me/src/app", isGit: true }],
  }));
  const snap = phonePeer.ofType("evt.snapshot").at(-1);
  const rows = snap?.payload?.workspaces;
  assert.ok(Array.isArray(rows) && isRecord(rows[0]) && rows[0].isGit === true);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
