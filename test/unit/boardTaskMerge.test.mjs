import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareDoneTasks,
  lastCompletedAt,
  mergeBoardTask,
  sortLaneTasks,
} from "../../web/boardTaskMerge.js";

describe("mergeBoardTask", () => {
  it("does not replace an open detail body with a clipped summary", () => {
    const full = {
      id: "t1",
      prompt: "p".repeat(3000),
      output: "o".repeat(5000),
      outputs: [{ iteration: 1, text: "o".repeat(5000) }],
      prompts: [{ iteration: 1, prompt: "p".repeat(3000) }],
      status: "running",
    };
    const summary = {
      ...full,
      prompt: `${"p".repeat(2000)}…`,
      output: `${"o".repeat(2000)}…`,
      outputs: [{ iteration: 1, text: `${"o".repeat(2000)}…` }],
      prompts: [{ iteration: 1, prompt: `${"p".repeat(2000)}…` }],
      status: "succeeded",
      boardSummary: true,
      outputTruncated: true,
      promptTruncated: true,
    };
    const merged = mergeBoardTask(full, summary);
    assert.equal(merged.output, full.output);
    assert.equal(merged.prompt, full.prompt);
    assert.equal(merged.status, "succeeded");
    assert.equal(merged.boardSummary, false);
  });

  it("clears endedAt/error/exitCode when a task restarts from terminal state", () => {
    const prev = {
      id: "t1",
      prompt: "hello",
      status: "succeeded",
      endedAt: "2026-11-05T01:00:00.000Z",
      error: "old err",
      exitCode: 1,
    };
    const incoming = {
      id: "t1",
      prompt: "hello",
      status: "queued",
      boardSummary: true,
    };
    const merged = mergeBoardTask(prev, incoming);
    assert.equal(merged.status, "queued");
    assert.equal(merged.endedAt, undefined);
    assert.equal(merged.error, undefined);
    assert.equal(merged.exitCode, undefined);
  });
});

describe("sortLaneTasks", () => {
  it("sorts done lane by last completion time descending (most recently completed first)", () => {
    const olderCreatedFinishedLater = {
      id: "task_re_completed",
      status: "succeeded",
      createdAt: "2026-11-01T08:00:00.000Z",
      updatedAt: "2026-11-05T12:00:00.000Z",
      endedAt: "2026-11-05T12:00:00.000Z",
    };
    const newerCreatedFinishedEarlier = {
      id: "task_finished_earlier",
      status: "succeeded",
      createdAt: "2026-11-05T10:00:00.000Z",
      updatedAt: "2026-11-05T10:05:00.000Z",
      endedAt: "2026-11-05T10:05:00.000Z",
    };
    const middleFinished = {
      id: "task_stopped_middle",
      status: "stopped",
      createdAt: "2026-11-03T09:00:00.000Z",
      updatedAt: "2026-11-05T11:00:00.000Z",
      endedAt: "2026-11-05T11:00:00.000Z",
    };
    const sorted = sortLaneTasks("done", [
      newerCreatedFinishedEarlier,
      middleFinished,
      olderCreatedFinishedLater,
    ]);
    assert.deepEqual(
      sorted.map((t) => t.id),
      ["task_re_completed", "task_stopped_middle", "task_finished_earlier"],
    );
  });

  it("uses latest output turn timestamp when newer than endedAt or when endedAt is missing", () => {
    const taskWithNewerTurn = {
      id: "t_turn",
      status: "succeeded",
      createdAt: "2026-11-01T00:00:00.000Z",
      endedAt: "2026-11-01T00:05:00.000Z",
      outputs: [
        { iteration: 1, text: "r1", at: "2026-11-01T00:05:00.000Z" },
        { iteration: 2, text: "r2", at: "2026-11-05T15:00:00.000Z" },
      ],
    };
    const taskFallbackUpdated = {
      id: "t_fallback",
      status: "failed",
      createdAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-05T14:00:00.000Z",
    };
    assert.equal(lastCompletedAt(taskWithNewerTurn), "2026-11-05T15:00:00.000Z");
    assert.equal(lastCompletedAt(taskFallbackUpdated), "2026-11-05T14:00:00.000Z");
    assert.ok(compareDoneTasks(taskWithNewerTurn, taskFallbackUpdated) < 0);
  });

  it("keeps non-done lanes sorted by createdAt descending", () => {
    const a = {
      id: "draft_old",
      status: "draft",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-05T12:00:00.000Z",
    };
    const b = {
      id: "draft_new",
      status: "draft",
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
    };
    const sorted = sortLaneTasks("draft", [a, b]);
    assert.deepEqual(sorted.map((t) => t.id), ["draft_new", "draft_old"]);
  });
});
