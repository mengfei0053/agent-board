import type { Envelope } from "../src/protocol.js";
import { startServer } from "../src/server.js";
import { invokedDirectly } from "./cli.js";
import { startFakeBoard } from "./fake-board.js";
import { PhoneSession } from "./fake-phone.js";

export type E2EResult = {
  createAck: Envelope;
  snapshot: Envelope;
  taskDone: Envelope;
  observerTaskDone: Envelope;
  idempotentReplay: boolean;
  unauthorizedRejected: boolean;
  droppedWithoutPhone: boolean;
  reconnectResynced: boolean;
};

export async function runE2E(options?: { quiet?: boolean }): Promise<E2EResult> {
  const quiet = options?.quiet ?? false;
  const adminToken = "admin-e2e-token-value";
  const boardToken = "board-e2e-token-value";
  const boardId = "thinkbook-main";
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    adminToken,
    boardToken,
    tokenTtlMs: 60_000,
    pairTtlMs: 60_000,
    cmdTimeoutMs: 2_000,
    pairAttemptLimit: 30,
    log: quiet ? () => {} : undefined,
  });
  const board = await startFakeBoard({
    wsUrl: server.wsUrl,
    boardId,
    token: boardToken,
    label: "ThinkBook",
    quiet,
  });

  try {
    await board.ready;
    const observer = await PhoneSession.connect({
      httpUrl: server.httpUrl,
      wsUrl: server.wsUrl,
      adminToken,
      boardIds: [boardId],
      deviceName: "observer-phone",
      quiet,
    });
    const driver = await PhoneSession.connect({
      httpUrl: server.httpUrl,
      wsUrl: server.wsUrl,
      adminToken,
      boardIds: [boardId],
      deviceName: "driver-phone",
      quiet,
    });
    const stranger = await PhoneSession.connect({
      httpUrl: server.httpUrl,
      wsUrl: server.wsUrl,
      adminToken,
      boardIds: ["other-board"],
      deviceName: "stranger-phone",
      quiet,
    });
    try {
      const listed = await driver.listBoards();
      const boards = listed.payload?.boards;
      if (!Array.isArray(boards) || !boards.some((item) => isRecord(item) && item.boardId === boardId && item.online === true)) {
        throw new Error("board.list hid the authorized online board");
      }
      const strangerList = await stranger.listBoards();
      const strangerBoards = strangerList.payload?.boards;
      if (Array.isArray(strangerBoards) && strangerBoards.some((item) => isRecord(item) && item.boardId === boardId)) {
        throw new Error("board.list exposed a board the phone is not allowed to see");
      }
      let unauthorizedRejected = false;
      try {
        await stranger.create({
          boardId,
          title: "nope",
          prompt: "should not run",
          idempotencyKey: "idem-stranger-1",
        });
      } catch (error) {
        unauthorizedRejected = error instanceof Error && error.message.includes("forbidden");
      }
      if (!unauthorizedRejected) throw new Error("unauthorized boardId was accepted");

      const observerDone = observer.waitForDone();
      await driver.subscribeTasks(boardId);
      await driver.subscribeLogs(boardId);
      const idempotencyKey = "idem-e2e-create";
      const createAck = await driver.create({
        boardId,
        title: "Fix login flake",
        prompt: "Investigate the flaky login test and propose a fix.",
        agent: "cursor",
        cwd: "/home/me/src/app",
        idempotencyKey,
      });
      const created = createAck.payload?.task;
      if (!isRecord(created) || typeof created.id !== "string") throw new Error("create ack missing task");
      const taskId = created.id;
      const replay = await driver.create({
        boardId,
        title: "Fix login flake",
        prompt: "Investigate the flaky login test and propose a fix.",
        idempotencyKey,
      });
      const idempotentReplay = replay.payload?.duplicate === true && isRecord(replay.payload?.task) && replay.payload.task.id === taskId && board.createCount() === 1;
      await driver.waitForTask("evt.task", taskId);
      await driver.waitForTask("evt.log", taskId);
      const snapshot = await driver.waitForTask("evt.snapshot", taskId);
      await driver.continueTask(boardId, taskId, "idem-e2e-continue");
      await driver.stopTask(boardId, taskId, "idem-e2e-stop", "user tapped stop");
      const taskDone = await driver.waitForTask("evt.task.done", taskId);
      const observerTaskDone = await observerDone;
      assertDone(taskDone, taskId);
      assertDone(observerTaskDone, taskId);
      if (stranger.messages().some((message) => message.type === "evt.task.done")) {
        throw new Error("evt.task.done reached a phone that is not allowed to see the board");
      }
      const eventId = taskDone.payload?.eventId;
      board.emitDuplicate();
      await delay(40);
      const copies = driver.messages().filter((message) => message.type === "evt.task.done" && message.payload?.eventId === eventId);
      if (copies.length !== 1) throw new Error(`duplicate eventId was delivered ${copies.length} times`);

      await observer.close();
      await driver.close();
      await stranger.close();
      await waitForHealth(server.httpUrl, (health) => health.phonesOnline === 0);
      const errorsBefore = board.errors().length;
      board.emitTaskUpdate();
      board.emitTaskDone({ summary: "phone offline drop probe", status: "succeeded" });
      await delay(80);
      const health = await readHealth(server.httpUrl);
      const droppedWithoutPhone = board.errors().length === errorsBefore && board.isOpen() && health.ok && health.phonesOnline === 0;

      const late = await PhoneSession.connect({
        httpUrl: server.httpUrl,
        wsUrl: server.wsUrl,
        adminToken,
        boardIds: [boardId],
        deviceName: "late-phone",
        quiet,
      });
      try {
        const mark = late.messages().length;
        await late.subscribeTasks(boardId);
        await delay(40);
        const fresh = late.messages().slice(mark);
        const snapAt = fresh.findIndex((message) => message.type === "evt.snapshot");
        const updateAt = fresh.findIndex((message) => message.type === "evt.task" && message.payload?.task && isRecord(message.payload.task));
        const reconnectResynced = snapAt >= 0 && updateAt > snapAt;
        if (!quiet) {
          console.log("[e2e] cmd.create executed", JSON.stringify(createAck));
          console.log("[e2e] evt.snapshot", JSON.stringify(snapshot));
          console.log("[e2e] evt.task.done", JSON.stringify(taskDone));
          console.log(`[e2e] idempotent replay: ${idempotentReplay}`);
          console.log(`[e2e] unauthorized board rejected: ${unauthorizedRejected}`);
          console.log(`[e2e] drop with no phone online: ${droppedWithoutPhone}`);
          console.log(`[e2e] reconnect snapshot then incremental: ${reconnectResynced}`);
        }
        return { createAck, snapshot, taskDone, observerTaskDone, idempotentReplay, unauthorizedRejected, droppedWithoutPhone, reconnectResynced };
      } finally {
        await late.close();
      }
    } finally {
      await observer.close().catch(() => {});
      await driver.close().catch(() => {});
      await stranger.close().catch(() => {});
    }
  } finally {
    await board.close();
    await server.close();
  }
}

function assertDone(message: Envelope, taskId: string): void {
  const payload = message.payload;
  if (!payload) throw new Error("evt.task.done missing payload");
  if (payload.taskId !== taskId) throw new Error("evt.task.done taskId mismatch");
  if (payload.boardId !== "thinkbook-main") throw new Error("evt.task.done boardId mismatch");
  if (payload.status !== "stopped") throw new Error(`evt.task.done status ${String(payload.status)}`);
  if (typeof payload.generation !== "number" || typeof payload.seq !== "number" || typeof payload.eventId !== "string") {
    throw new Error("evt.task.done missing generation, seq, or eventId");
  }
}

async function readHealth(httpUrl: string): Promise<{ ok: boolean; phonesOnline: number }> {
  const response = await fetch(new URL("/health", httpUrl));
  if (!response.ok) throw new Error(`health ${response.status}`);
  return (await response.json()) as { ok: boolean; phonesOnline: number };
}

async function waitForHealth(httpUrl: string, pred: (health: { ok: boolean; phonesOnline: number }) => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    if (pred(await readHealth(httpUrl))) return;
    await delay(20);
  }
  throw new Error("timed out waiting for health");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const result = await runE2E({ quiet: false });
  if (!result.idempotentReplay || !result.unauthorizedRejected || !result.droppedWithoutPhone || !result.reconnectResynced) {
    throw new Error("e2e assertions failed");
  }
  console.log("[e2e] ok");
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
