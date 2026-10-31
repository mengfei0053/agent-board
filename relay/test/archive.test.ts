import assert from "node:assert/strict";
import test from "node:test";
import { ARCHIVE_CAPABILITY } from "../src/protocol.js";
import { parseMessage } from "../src/protocol.js";
import { frame, helloPhone, registerBoard, setup, task } from "./support.js";

test("archive list is unsupported until the board advertises it, then a page is forwarded", () => {
  const fx = setup();
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.archive.list", "arch-old", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-key-1",
    limit: 20,
  }));
  const rejected = phonePeer.messages.at(-1);
  assert.equal(rejected?.type, "err");
  assert.equal(rejected?.payload?.code, "unsupported");
  assert.equal(boardPeer.messages.some((message) => message.type === "cmd.archive.list"), false);

  const capablePeer = fx.peer();
  const capable = fx.hub.attachBoard(capablePeer.send, capablePeer.close);
  fx.hub.handleBoard(capable, frame("board.register", "reg-cap", {
    boardId: "thinkbook-main",
    token: "board-token-value",
    label: "ThinkBook",
    capabilities: [ARCHIVE_CAPABILITY],
  }));
  assert.equal(board.closed || capable.boardId === "thinkbook-main", true);
  const listedPeer = fx.peer();
  const listed = helloPhone(fx.hub, fx.auth, listedPeer, "pixel-2");
  fx.hub.handlePhone(listed.conn, frame("board.list", "list-1", {}));
  const boards = listedPeer.messages.at(-1)?.payload?.boards as Array<{ capabilities?: string[] }>;
  assert.deepEqual(boards[0]?.capabilities, [ARCHIVE_CAPABILITY]);

  capablePeer.messages.length = 0;
  fx.hub.handlePhone(listed.conn, frame("cmd.archive.list", "arch-1", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-key-2",
  }));
  const forwarded = capablePeer.messages.find((message) => message.type === "cmd.archive.list");
  assert.ok(forwarded);
  assert.equal(forwarded?.payload?.limit, 20);
  fx.hub.handleBoard(capable, frame("ack", "ack-arch", {
    ref: forwarded?.id,
    stage: "executed",
    boardId: "thinkbook-main",
    idempotencyKey: "archive-key-2",
    archive: {
      tasks: [{ ...task("archived", "task_old"), title: "Old" }],
      nextCursor: "1700000000000:task_old",
    },
  }));
  const page = [...listedPeer.messages].reverse().find((message) =>
    message.type === "ack" && message.payload?.ref === "arch-1" && message.payload?.stage === "executed");
  const archive = page?.payload?.archive as { tasks: Array<{ status: string; id: string }>; nextCursor?: string };
  assert.equal(archive.tasks[0]?.status, "archived");
  assert.equal(archive.tasks[0]?.id, "task_old");
  assert.equal(archive.nextCursor, "1700000000000:task_old");
  fx.hub.dispose?.();
});

test("hot snapshots still reject archived rows and archive pages accept only archived", () => {
  const snapshot = parseMessage({
    v: 1,
    id: "snap-arch",
    type: "evt.snapshot",
    ts: 10,
    payload: {
      boardId: "thinkbook-main",
      generation: 1,
      seq: 1,
      eventId: "evt-1",
      version: 1,
      capturedAt: 10,
      tasks: [task("archived")],
    },
  });
  assert.equal(snapshot.ok, false);
  const live = parseMessage({
    v: 1,
    id: "snap-live",
    type: "evt.snapshot",
    ts: 10,
    payload: {
      boardId: "thinkbook-main",
      generation: 1,
      seq: 1,
      eventId: "evt-1",
      version: 1,
      capturedAt: 10,
      tasks: [task("running")],
    },
  });
  assert.equal(live.ok, true);
  const detail = parseMessage({
    v: 1,
    id: "ack-detail",
    type: "ack",
    ts: 10,
    payload: {
      ref: "detail-1",
      stage: "executed",
      task: { ...task("archived"), detail: "full", prompt: "keep this" },
    },
  });
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  const taskBody = detail.envelope.payload?.task as { status?: string; prompt?: string };
  assert.equal(taskBody.status, "archived");
  assert.equal(taskBody.prompt, "keep this");
  const mixed = parseMessage({
    v: 1,
    id: "ack-mixed",
    type: "ack",
    ts: 10,
    payload: {
      ref: "arch-2",
      stage: "executed",
      archive: { tasks: [task("running")] },
    },
  });
  assert.equal(mixed.ok, false);
});

test("another board cannot read this archive page", () => {
  const fx = setup();
  const boardPeer = fx.peer();
  fx.hub.handleBoard(fx.hub.attachBoard(boardPeer.send, boardPeer.close), frame("board.register", "reg-cap", {
    boardId: "thinkbook-main",
    token: "board-token-value",
    capabilities: [ARCHIVE_CAPABILITY],
  }));
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.archive.list", "arch-foreign", {
    boardId: "other-board",
    idempotencyKey: "archive-key-9",
  }));
  const err = phonePeer.messages.at(-1);
  assert.equal(err?.type, "err");
  assert.equal(err?.payload?.code, "forbidden");
});
