import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Envelope } from "../src/protocol.js";
import { cursor, frame, helloPhone, registerBoard, setup, task, type Peer } from "./support.js";

const open: Array<{ dispose: () => void }> = [];

afterEach(() => {
  for (const hub of open.splice(0)) hub.dispose();
});

test("bad board and device tokens are rejected and board.list hides other boards", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = fx.hub.attachBoard(boardPeer.send, boardPeer.close);
  fx.hub.handleBoard(board, frame("board.register", "reg-bad", { boardId: "thinkbook-main", token: "nope" }));
  assert.equal(codeOf(boardPeer.ofType("err").at(-1)), "unauthorized");

  registerBoard(fx.hub, fx.peer());
  const strangerPeer = fx.peer();
  const stranger = helloPhone(fx.hub, fx.auth, strangerPeer, "stranger", ["other-board"]);
  fx.hub.handlePhone(stranger.conn, frame("board.list", "list-stranger", {}));
  const boards = byRef(strangerPeer, "list-stranger")?.payload?.boards;
  assert.equal(Array.isArray(boards) && boards.every((item) => isRecord(item) && item.boardId === "other-board"), true);

  const phonePeer = fx.peer();
  const phone = fx.hub.attachPhone(phonePeer.send, phonePeer.close);
  fx.hub.handlePhone(phone, frame("client.hello", "hello-bad", { token: "dt_not-a-real-token" }));
  assert.equal(codeOf(phonePeer.ofType("err").at(-1)), "unauthorized");
});

test("commands ack accepted then executed and a repeat does not create again", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "driver");
  fx.hub.handlePhone(phone.conn, frame("sub.tasks", "sub-1", { boardId: "thinkbook-main" }));
  fx.hub.handlePhone(phone.conn, frame("sub.logs", "sub-2", { boardId: "thinkbook-main" }));
  fx.hub.handlePhone(phone.conn, frame("evt.task.done", "nope", {
    ...cursor(1, "nope"),
    taskId: "task_01",
    status: "stopped",
  }));
  assert.equal(codeOf(phonePeer.ofType("err").at(-1)), "forbidden");

  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-1", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-create-01",
    title: "Fix login flake",
    prompt: "Investigate the flaky login test and propose a fix.",
    agent: "cursor",
    cwd: "/home/me/src/app",
  }));
  assert.equal(byRef(phonePeer, "create-1")?.payload?.stage, "accepted");
  const forwarded = boardPeer.ofType("cmd.create").at(-1);
  assert.equal(forwarded?.payload?.idempotencyKey, "idem-create-01");
  fx.hub.handleBoard(board, frame("ack", "ack-create", { ref: forwarded?.id, stage: "executed", task: task("queued") }));
  assert.equal(stageOf(phonePeer, "create-1", "executed"), "executed");

  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-2", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-create-01",
    title: "Fix login flake",
    prompt: "Investigate the flaky login test and propose a fix.",
  }));
  assert.equal(boardPeer.ofType("cmd.create").length, 1);
  assert.equal(byRef(phonePeer, "create-2")?.payload?.duplicate, true);
  assert.equal(byRef(phonePeer, "create-2")?.payload?.stage, "executed");

  fx.hub.handlePhone(phone.conn, frame("cmd.continue", "continue-1", {
    boardId: "thinkbook-main",
    taskId: "task_01",
    idempotencyKey: "idem-continue",
  }));
  const cont = boardPeer.ofType("cmd.continue").at(-1);
  fx.hub.handleBoard(board, frame("ack", "ack-cont", { ref: cont?.id, task: task("running") }));
  assert.equal(stageOf(phonePeer, "continue-1", "executed"), "executed");

  fx.hub.handlePhone(phone.conn, frame("cmd.stop", "stop-1", {
    boardId: "thinkbook-main",
    taskId: "task_01",
    idempotencyKey: "idem-stop-01",
    reason: "user tapped stop",
  }));
  const stop = boardPeer.ofType("cmd.stop").at(-1);
  assert.equal(stop?.payload?.reason, "user tapped stop");
  fx.hub.handleBoard(board, frame("err", "err-stop", { ref: stop?.id, code: "rejected", message: "busy" }));
  assert.equal(stageOf(phonePeer, "stop-1", "failed"), "failed");
});

test("timeout is stored for lookup and is not blindly retried", async () => {
  const fx = setup({ cmdTimeoutMs: 30 });
  open.push(fx.hub);
  const boardPeer = fx.peer();
  registerBoard(fx.hub, boardPeer);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "slow", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-slow-01",
    title: "Slow",
    prompt: "wait",
  }));
  await delay(60);
  assert.equal(stageOf(phonePeer, "slow", "timeout"), "timeout");
  fx.hub.handlePhone(phone.conn, frame("cmd.lookup", "look-1", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-slow-01",
    cmd: "cmd.create",
  }));
  assert.equal(byRef(phonePeer, "look-1")?.payload?.stage, "timeout");
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "slow-2", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-slow-01",
    title: "Slow",
    prompt: "wait",
  }));
  assert.equal(boardPeer.ofType("cmd.create").length, 1);
  assert.equal(byRef(phonePeer, "slow-2")?.payload?.duplicate, true);
});

test("an offline board rejects the command without consuming the idempotency key", () => {
  const fx = setup();
  open.push(fx.hub);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "offline", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-offline",
    title: "Later",
    prompt: "not yet",
  }));
  assert.equal(codeOf(byRef(phonePeer, "offline")), "board_offline");
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "online", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-offline",
    title: "Later",
    prompt: "not yet",
  }));
  assert.equal(boardPeer.ofType("cmd.create").length, 1);
  fx.hub.handleBoard(board, frame("ack", "ack-online", { ref: boardPeer.ofType("cmd.create")[0]?.id, task: task() }));
  assert.equal(stageOf(phonePeer, "online", "executed"), "executed");
});

test("an unauthorized boardId is rejected without revealing whether it is online", () => {
  const fx = setup();
  open.push(fx.hub);
  registerBoard(fx.hub, fx.peer());
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "other", ["other-board"]);
  fx.hub.handlePhone(phone.conn, frame("cmd.stop", "nope", {
    boardId: "thinkbook-main",
    taskId: "task_01",
    idempotencyKey: "idem-nope-01",
  }));
  const err = byRef(phonePeer, "nope");
  assert.equal(err?.type, "err");
  assert.equal(err?.payload?.code, "forbidden");
  assert.equal(String(err?.payload?.message).includes("not connected"), false);
});

test("evt.task.done reaches every online authorized phone once", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const driverPeer = fx.peer();
  const driver = helloPhone(fx.hub, fx.auth, driverPeer, "driver");
  const strangerPeer = fx.peer();
  helloPhone(fx.hub, fx.auth, strangerPeer, "stranger", ["other-board"]);

  fx.hub.handleBoard(board, frame("evt.task.done", "done-1", {
    ...cursor(1, "done-1"),
    taskId: "task_01",
    status: "stopped",
    title: "Fix login flake",
    summary: "Stopped by client",
  }));
  assert.equal(driverPeer.ofType("evt.task.done").length, 1);
  assert.equal(strangerPeer.ofType("evt.task.done").length, 0);
  const payload = driverPeer.ofType("evt.task.done")[0]?.payload;
  assert.equal(payload?.taskId, "task_01");
  assert.equal(payload?.eventId, "done-1");

  fx.hub.handleBoard(board, frame("evt.task.done", "done-1b", {
    ...cursor(1, "done-1"),
    taskId: "task_01",
    status: "stopped",
  }));
  assert.equal(driverPeer.ofType("evt.task.done").length, 1);

  fx.hub.handleBoard(board, frame("evt.task.done", "done-2", {
    ...cursor(2, "done-2"),
    taskId: "task_01",
    status: "stopped",
  }));
  assert.equal(driverPeer.ofType("evt.task.done").length, 1);

  fx.hub.disconnectPhone(driver.conn);
  const before = boardPeer.messages.length;
  fx.hub.handleBoard(board, frame("evt.task.done", "done-3", {
    ...cursor(3, "done-3"),
    taskId: "task_02",
    status: "failed",
    summary: "no phone online",
  }));
  assert.equal(boardPeer.messages.length, before);
  assert.equal(fx.logs.some((line) => line.includes("dropped evt.task.done")), true);
});

test("reconnect delivers the snapshot and then incremental events", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  fx.hub.handleBoard(board, frame("evt.snapshot", "snap-1", {
    ...cursor(1, "snap-1"),
    version: 1,
    capturedAt: NOW,
    tasks: [task("running")],
  }));
  fx.hub.handleBoard(board, frame("evt.task", "task-2", { ...cursor(2, "task-2"), task: task("running") }));

  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "late");
  fx.hub.handlePhone(phone.conn, frame("sub.tasks", "sub-late", { boardId: "thinkbook-main" }));
  const firstSnap = phonePeer.ofType("evt.snapshot").length;
  const firstTask = phonePeer.ofType("evt.task").length;
  assert.equal(firstSnap, 1);
  assert.equal(firstTask, 1);
  assert.ok(indexOf(phonePeer, "evt.snapshot") < indexOf(phonePeer, "evt.task"));

  fx.hub.disconnectPhone(phone.conn);
  fx.hub.handleBoard(board, frame("evt.task", "task-3", { ...cursor(3, "task-3"), task: task("running", "task_02") }));
  const againPeer = fx.peer();
  const again = helloPhone(fx.hub, fx.auth, againPeer, "return");
  fx.hub.handlePhone(again.conn, frame("sub.tasks", "sub-return", { boardId: "thinkbook-main", afterSeq: 1 }));
  assert.equal(againPeer.ofType("evt.snapshot").length, 1);
  assert.equal(againPeer.ofType("evt.task").length, 2);
  assert.ok(indexOf(againPeer, "evt.snapshot") < lastIndexOf(againPeer, "evt.task"));
});

test("a sequence gap is reported and a board generation change forces a resync", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "watcher");
  fx.hub.handlePhone(phone.conn, frame("sub.tasks", "sub", { boardId: "thinkbook-main" }));
  fx.hub.handleBoard(board, frame("evt.snapshot", "snap-1", {
    ...cursor(1, "snap-1"),
    version: 1,
    capturedAt: NOW,
    tasks: [],
  }));
  fx.hub.handleBoard(board, frame("evt.task", "task-4", { ...cursor(4, "task-4"), task: task() }));
  assert.equal(codeOf(boardPeer.ofType("err").at(-1)), "seq_gap");
  assert.equal(phonePeer.ofType("evt.gap").at(-1)?.payload?.reason, "seq_gap");
  assert.equal(phonePeer.ofType("evt.task").length, 0);

  const nextPeer = fx.peer();
  registerBoard(fx.hub, nextPeer);
  assert.equal(phonePeer.ofType("evt.gap").at(-1)?.payload?.reason, "generation_changed");
});

test("a rotated or expired phone token does not keep receiving events", () => {
  const fx = setup({ tokenTtlMs: 1_000 });
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const stalePeer = fx.peer();
  const stale = helloPhone(fx.hub, fx.auth, stalePeer, "stale");
  fx.hub.handlePhone(stale.conn, frame("sub.tasks", "sub-stale", { boardId: "thinkbook-main" }));

  const refreshed = fx.auth.refresh(stale.token);
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  fx.hub.kickToken(stale.token);
  assert.equal(stalePeer.closed, true);

  const freshPeer = fx.peer();
  const fresh = fx.hub.attachPhone(freshPeer.send, freshPeer.close);
  fx.hub.handlePhone(fresh, frame("client.hello", "hello-fresh", { token: refreshed.deviceToken, name: "fresh" }));
  fx.hub.handlePhone(fresh, frame("sub.tasks", "sub-fresh", { boardId: "thinkbook-main" }));
  fx.hub.handleBoard(board, frame("evt.task", "task-rot", { ...cursor(1, "task-rot"), task: task("running") }));
  fx.hub.handleBoard(board, frame("evt.task.done", "done-rot", {
    ...cursor(2, "done-rot"),
    taskId: "task_01",
    status: "succeeded",
    title: "Fix login flake",
  }));
  assert.equal(stalePeer.ofType("evt.task").length, 0);
  assert.equal(stalePeer.ofType("evt.task.done").length, 0);
  assert.equal(freshPeer.ofType("evt.task").length, 1);
  assert.equal(freshPeer.ofType("evt.task.done").length, 1);

  const expiredPeer = fx.peer();
  const expired = helloPhone(fx.hub, fx.auth, expiredPeer, "expired");
  fx.hub.handlePhone(expired.conn, frame("sub.tasks", "sub-expired", { boardId: "thinkbook-main" }));
  fx.clock.t += 1_000;
  fx.hub.handleBoard(board, frame("evt.task", "task-exp", { ...cursor(3, "task-exp"), task: task("running", "task_02") }));
  assert.equal(expiredPeer.closed, true);
  assert.equal(expiredPeer.ofType("evt.task").length, 0);
  assert.equal(expiredPeer.ofType("evt.task.done").length, 0);
  assert.equal(freshPeer.ofType("evt.task").some((message) => {
    const body = message.payload?.task;
    return isRecord(body) && body.id === "task_02";
  }), false);
});

test("another board cannot complete a command by guessing its id", () => {
  const fx = setup();
  open.push(fx.hub);
  const aPeer = fx.peer();
  const boardA = registerBoard(fx.hub, aPeer, "thinkbook-main");
  const bPeer = fx.peer();
  const boardB = registerBoard(fx.hub, bPeer, "other-board");
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "owner");
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-a", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-board-a",
    title: "Owned",
    prompt: "only A may ack",
  }));
  const commandId = aPeer.ofType("cmd.create").at(-1)?.id;
  assert.equal(typeof commandId, "string");
  fx.hub.handleBoard(boardB, frame("ack", "spoof-ack", { ref: commandId, stage: "executed", task: task("queued") }));
  assert.equal(codeOf(bPeer.ofType("err").at(-1)), "forbidden");
  fx.hub.handleBoard(boardB, frame("err", "spoof-err", { ref: commandId, code: "rejected", message: "nope" }));
  assert.equal(codeOf(bPeer.ofType("err").at(-1)), "forbidden");
  assert.equal(stageOf(phonePeer, "create-a", "executed"), undefined);
  assert.equal(stageOf(phonePeer, "create-a", "accepted"), "accepted");
  fx.hub.handleBoard(boardA, frame("ack", "real-ack", { ref: commandId, task: task("queued") }));
  assert.equal(stageOf(phonePeer, "create-a", "executed"), "executed");
});

test("re-registering a socket drops the previous board and disconnect fails in-flight commands", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const conn = registerBoard(fx.hub, boardPeer, "board-x");
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "mover", ["board-x", "board-y", "board-z"]);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-x", {
    boardId: "board-x",
    idempotencyKey: "idem-rebind-1",
    title: "Bound",
    prompt: "to x",
  }));
  fx.hub.handleBoard(conn, frame("board.register", "reg-y", {
    boardId: "board-y",
    token: "board-token-value",
    label: "Y",
  }));
  assert.equal(stageOf(phonePeer, "create-x", "failed"), "failed");
  assert.equal(byRef(phonePeer, "create-x")?.payload?.code, "board_disconnected");
  fx.hub.handlePhone(phone.conn, frame("board.list", "list-rebind", {}));
  const listed = byRef(phonePeer, "list-rebind")?.payload?.boards;
  assert.equal(onlineOf(listed, "board-x"), false);
  assert.equal(onlineOf(listed, "board-y"), true);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-x2", {
    boardId: "board-x",
    idempotencyKey: "idem-rebind-2",
    title: "Gone",
    prompt: "offline",
  }));
  assert.equal(codeOf(byRef(phonePeer, "create-x2")), "board_offline");

  const livePeer = fx.peer();
  const live = registerBoard(fx.hub, livePeer, "board-z");
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-z", {
    boardId: "board-z",
    idempotencyKey: "idem-rebind-3",
    title: "Live",
    prompt: "then drop",
  }));
  fx.hub.disconnectBoard(live);
  assert.equal(stageOf(phonePeer, "create-z", "failed"), "failed");
  fx.hub.handlePhone(phone.conn, frame("board.list", "list-drop", {}));
  assert.equal(onlineOf(byRef(phonePeer, "list-drop")?.payload?.boards, "board-z"), false);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-z2", {
    boardId: "board-z",
    idempotencyKey: "idem-rebind-4",
    title: "Live",
    prompt: "offline now",
  }));
  assert.equal(codeOf(byRef(phonePeer, "create-z2")), "board_offline");
});

test("task replay omits logs and historical completion events", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  fx.hub.handleBoard(board, frame("evt.log", "log-1", {
    ...cursor(1, "log-1"),
    taskId: "task_01",
    stream: "system",
    line: "connector accepted create",
  }));
  fx.hub.handleBoard(board, frame("evt.task", "task-2", { ...cursor(2, "task-2"), task: task("running") }));
  fx.hub.handleBoard(board, frame("evt.snapshot", "snap-3", {
    ...cursor(3, "snap-3"),
    version: 3,
    capturedAt: NOW,
    tasks: [task("stopped")],
  }));
  fx.hub.handleBoard(board, frame("evt.task.done", "done-4", {
    ...cursor(4, "done-4"),
    taskId: "task_01",
    status: "stopped",
    title: "Fix login flake",
    summary: "Stopped by client",
  }));
  fx.hub.handleBoard(board, frame("evt.task", "task-5", { ...cursor(5, "task-5"), task: task("stopped") }));

  const taskPeer = fx.peer();
  const tasks = helloPhone(fx.hub, fx.auth, taskPeer, "tasks-only");
  fx.hub.handlePhone(tasks.conn, frame("sub.tasks", "sub-tasks", { boardId: "thinkbook-main" }));
  assert.equal(taskPeer.ofType("evt.snapshot").length, 1);
  assert.equal(taskPeer.ofType("evt.snapshot")[0]?.payload?.tasks && Array.isArray(taskPeer.ofType("evt.snapshot")[0]?.payload?.tasks), true);
  const snapTasks = taskPeer.ofType("evt.snapshot")[0]?.payload?.tasks;
  assert.equal(Array.isArray(snapTasks) && isRecord(snapTasks[0]) && snapTasks[0].status, "stopped");
  assert.equal(taskPeer.ofType("evt.task.done").length, 0);
  assert.equal(taskPeer.ofType("evt.log").length, 0);
  assert.equal(taskPeer.ofType("evt.task").length, 1);

  const logPeer = fx.peer();
  const logs = helloPhone(fx.hub, fx.auth, logPeer, "logs-only");
  fx.hub.handlePhone(logs.conn, frame("sub.logs", "sub-logs", { boardId: "thinkbook-main" }));
  assert.equal(logPeer.ofType("evt.log").length, 1);
  assert.equal(logPeer.ofType("evt.task.done").length, 0);
  assert.equal(logPeer.ofType("evt.task").length, 0);
});

test("an accepted command survives an idempotency TTL shorter than the command timeout", () => {
  const fx = setup({ idempotencyTtlMs: 500, cmdTimeoutMs: 60_000 });
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "waiter");
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-ttl", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-ttl-short",
    title: "Hold",
    prompt: "until the board answers",
  }));
  const commandId = boardPeer.ofType("cmd.create").at(-1)?.id;
  fx.clock.t += 10_000;
  fx.hub.handlePhone(phone.conn, frame("cmd.lookup", "look-ttl", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-ttl-short",
    cmd: "cmd.create",
  }));
  assert.equal(byRef(phonePeer, "look-ttl")?.payload?.stage, "accepted");
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-ttl-2", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-ttl-short",
    title: "Hold",
    prompt: "until the board answers",
  }));
  assert.equal(boardPeer.ofType("cmd.create").length, 1);
  assert.equal(byRef(phonePeer, "create-ttl-2")?.payload?.duplicate, true);
  fx.hub.handleBoard(board, frame("ack", "ack-ttl", { ref: commandId, task: task("queued") }));
  assert.equal(stageOf(phonePeer, "create-ttl", "executed"), "executed");
});

test("a sequence gap is still reported to a phone that subscribes later", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  fx.hub.handleBoard(board, frame("evt.snapshot", "snap-gap", {
    ...cursor(1, "snap-gap"),
    version: 1,
    capturedAt: NOW,
    tasks: [task("running")],
  }));
  fx.hub.handleBoard(board, frame("evt.task", "task-gap", { ...cursor(4, "task-gap"), task: task("running") }));
  assert.equal(codeOf(boardPeer.ofType("err").at(-1)), "seq_gap");

  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "late-gap");
  fx.hub.handlePhone(phone.conn, frame("sub.tasks", "sub-gap", { boardId: "thinkbook-main" }));
  const gap = phonePeer.ofType("evt.gap").at(-1);
  assert.equal(gap?.payload?.reason, "seq_gap");
  assert.equal(gap?.payload?.expectedSeq, 2);
  assert.equal(gap?.payload?.gotSeq, 4);
  assert.equal(phonePeer.ofType("evt.snapshot").length, 1);
  assert.ok(indexOf(phonePeer, "evt.gap") < indexOf(phonePeer, "evt.snapshot"));
});

test("workspace commands and task workspaceId survive a relay hop", () => {
  const fx = setup();
  open.push(fx.hub);
  const boardPeer = fx.peer();
  const board = registerBoard(fx.hub, boardPeer);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer, "workspaces");
  fx.hub.handlePhone(phone.conn, frame("sub.tasks", "sub-ws", { boardId: "thinkbook-main" }));

  fx.hub.handleBoard(board, frame("evt.snapshot", "snap-ws", {
    ...cursor(1, "snap-ws"),
    version: 1,
    capturedAt: NOW,
    tasks: [{ ...task("running"), workspaceId: "ws_app" }],
    workspaces: [{ id: "ws_app", name: "App", path: "/home/me/src/app", isGit: true }],
  }));
  const snap = phonePeer.ofType("evt.snapshot").at(-1);
  const snapTask = Array.isArray(snap?.payload?.tasks) ? snap?.payload?.tasks[0] : undefined;
  assert.equal(isRecord(snapTask) && snapTask.workspaceId, "ws_app");

  fx.hub.handlePhone(phone.conn, frame("cmd.workspace.create", "ws-new", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    name: "Other",
    path: "/tmp/other",
  }));
  assert.equal(byRef(phonePeer, "ws-new")?.payload?.stage, "accepted");
  const forwarded = boardPeer.ofType("cmd.workspace.create").at(-1);
  assert.equal(forwarded?.payload?.name, "Other");
  fx.hub.handleBoard(board, frame("ack", "ack-ws", {
    ref: forwarded?.id,
    stage: "executed",
    workspace: { id: "ws_other", name: "Other", path: "/tmp/other", isGit: false },
  }));
  const executed = byRef(phonePeer, "ws-new");
  assert.equal(executed?.payload?.stage, "executed");
  assert.equal(isRecord(executed?.payload?.workspace) && executed?.payload?.workspace.id, "ws_other");

  fx.hub.handlePhone(phone.conn, frame("cmd.workspace.create", "ws-new-2", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    name: "Other",
    path: "/tmp/other",
  }));
  assert.equal(boardPeer.ofType("cmd.workspace.create").length, 1);
  assert.equal(byRef(phonePeer, "ws-new-2")?.payload?.duplicate, true);
  assert.equal(isRecord(byRef(phonePeer, "ws-new-2")?.payload?.workspace) && byRef(phonePeer, "ws-new-2")?.payload?.workspace.name, "Other");

  fx.hub.handlePhone(phone.conn, frame("cmd.workspace.delete", "ws-del", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-del-1",
    workspaceId: "ws_other",
  }));
  const del = boardPeer.ofType("cmd.workspace.delete").at(-1);
  fx.hub.handleBoard(board, frame("ack", "ack-del", { ref: del?.id, stage: "executed", deleted: "ws_other" }));
  assert.equal(byRef(phonePeer, "ws-del")?.payload?.deleted, "ws_other");
});

const NOW = 1_700_000_000_000;

function byRef(peer: Peer, ref: string): Envelope | undefined {
  return [...peer.messages].reverse().find((message) => message.payload?.ref === ref);
}

function stageOf(peer: Peer, ref: string, stage: string): unknown {
  return peer.messages.find((message) => message.payload?.ref === ref && message.payload?.stage === stage)?.payload?.stage;
}

function codeOf(message: Envelope | undefined): unknown {
  return message?.payload?.code;
}

function indexOf(peer: Peer, type: string): number {
  return peer.messages.findIndex((message) => message.type === type);
}

function lastIndexOf(peer: Peer, type: string): number {
  return peer.messages.findLastIndex((message) => message.type === type);
}

function onlineOf(boards: unknown, boardId: string): boolean | undefined {
  if (!Array.isArray(boards)) return undefined;
  const entry = boards.find((item) => isRecord(item) && item.boardId === boardId);
  if (!isRecord(entry) || typeof entry.online !== "boolean") return undefined;
  return entry.online;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
