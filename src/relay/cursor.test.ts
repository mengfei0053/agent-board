import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RelayCursor } from "./cursor.js";
import { mapBoardTask } from "./map.js";
import { makeTask } from "./harness.js";

describe("relay cursor", () => {
  it("emits evt.task on signature change and evt.task.done only on first terminal entry", () => {
    const cursor = new RelayCursor(3);
    const running = mapBoardTask(makeTask({ status: "running", title: "Ship" }))!;
    cursor.buildSnapshot("thinkbook", [running], []);
    const again = cursor.observeTask("thinkbook", running);
    assert.equal(again.length, 0);

    const renamed = cursor.observeTask("thinkbook", { ...running, title: "Ship it" });
    assert.deepEqual(renamed.map((frame) => frame.type), ["evt.task"]);

    const done = cursor.observeTask("thinkbook", { ...running, title: "Ship it", status: "succeeded" });
    assert.deepEqual(done.map((frame) => frame.type), ["evt.task", "evt.task.done"]);
    assert.equal(done[1]?.payload.eventId, "done-3-t1");
    assert.equal(done[1]?.payload.status, "succeeded");

    const repeat = cursor.observeTask("thinkbook", { ...running, title: "Ship it", status: "succeeded" });
    assert.equal(repeat.length, 0);

    const seqs = [renamed[0], done[0], done[1]].map((frame) => frame?.payload.seq as number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  });

  it("keeps a pending terminal transition across a refresh snapshot", () => {
    const cursor = new RelayCursor(1);
    const runningA = mapBoardTask(makeTask({ id: "A", status: "running", title: "A" }))!;
    const runningB = mapBoardTask(makeTask({ id: "B", status: "running", title: "B" }))!;
    cursor.buildSnapshot("thinkbook", [runningA, runningB], []);
    const succeededA = { ...runningA, status: "succeeded" as const };
    cursor.refreshSnapshot("thinkbook", [succeededA], []);
    const frames = cursor.observeTask("thinkbook", succeededA);
    assert.deepEqual(frames.map((frame) => frame.type), ["evt.task", "evt.task.done"]);
    assert.equal(frames[1]?.payload.taskId, "A");
  });

  it("does not emit done for a task that was already terminal in the snapshot", () => {
    const cursor = new RelayCursor(2);
    const done = mapBoardTask(makeTask({ status: "failed" }))!;
    const snap = cursor.buildSnapshot("thinkbook", [done], []);
    assert.equal(snap.payload.generation, 2);
    assert.equal(snap.payload.seq, 1);
    const frames = cursor.observeTask("thinkbook", done);
    assert.equal(frames.length, 0);
  });

  it("marks log lines as system and truncates them", () => {
    const cursor = new RelayCursor(1);
    const frame = cursor.observeLog("thinkbook", "t1", `x${"y".repeat(5_000)}`);
    assert.equal(frame?.payload.stream, "system");
    assert.equal(String(frame?.payload.line).endsWith("…"), true);
    assert.ok(String(frame?.payload.line).length < 5_000);
    assert.equal(cursor.observeLog("thinkbook", "t1", "   "), null);
  });
});
