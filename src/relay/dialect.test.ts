import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RelayCursor } from "./cursor.js";
import { eventsFromBoardEvent } from "./dialect.js";
import { makeTask, makeWorkspace } from "./harness.js";

describe("relay dialect", () => {
  it("drops archived upserts and asks for a snapshot on delete", () => {
    const cursor = new RelayCursor(1);
    const running = makeTask({ status: "running" });
    cursor.buildSnapshot("b", [], []);
    const archived = eventsFromBoardEvent(cursor, { type: "task_upsert", task: { ...running, status: "archived" } }, "b");
    assert.deepEqual(archived, { frames: [], needsSnapshot: false });
    const known = new RelayCursor(2);
    const live = makeTask({ id: "live", status: "running" });
    known.buildSnapshot("b", [], []);
    known.observeTask("b", {
      id: "live",
      title: live.title,
      status: "running",
      updatedAt: 1,
    });
    const removed = eventsFromBoardEvent(known, { type: "task_upsert", task: { ...live, status: "archived" } }, "b");
    assert.equal(removed.needsSnapshot, true);
    assert.equal(removed.frames.length, 0);
    assert.equal(removed.frames.some((frame) => frame.type === "evt.task.done"), false);
    const deleted = eventsFromBoardEvent(cursor, { type: "task_delete", taskIds: [running.id] }, "b");
    assert.equal(deleted.needsSnapshot, true);
    assert.equal(deleted.frames.length, 0);
  });

  it("maps task_log to a system stream", () => {
    const cursor = new RelayCursor(4);
    const result = eventsFromBoardEvent(cursor, {
      type: "task_log",
      taskId: "t1",
      line: "hello",
      at: "2026-10-31T00:00:00.000Z",
    }, "b");
    assert.equal(result.needsSnapshot, false);
    assert.equal(result.frames[0]?.type, "evt.log");
    assert.equal(result.frames[0]?.payload.stream, "system");
    assert.equal(result.frames[0]?.payload.generation, 4);
  });

  it("refreshes workspaces with a snapshot and ignores hello", () => {
    const cursor = new RelayCursor(1);
    const workspace = makeWorkspace();
    assert.equal(eventsFromBoardEvent(cursor, { type: "workspace_upsert", workspace }, "b").needsSnapshot, true);
    assert.equal(eventsFromBoardEvent(cursor, { type: "workspace_delete", workspaceIds: ["w1"] }, "b").needsSnapshot, true);
    assert.deepEqual(
      eventsFromBoardEvent(cursor, { type: "hello", tasks: [], workspaces: [] }, "b"),
      { frames: [], needsSnapshot: false },
    );
  });
});
