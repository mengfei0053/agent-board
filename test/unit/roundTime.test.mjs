import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRoundDuration, formatTaskDuration } from "../../web/roundTime.js";

describe("formatRoundDuration", () => {
  it("formats sub-minute durations in seconds", () => {
    assert.equal(
      formatRoundDuration("2026-11-05T05:35:37.000Z", "2026-11-05T05:35:37.000Z"),
      "0秒",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T05:35:37.000Z", "2026-11-05T05:35:37.400Z"),
      "1秒",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T05:35:37.026Z", "2026-11-05T05:36:33.899Z"),
      "57秒",
    );
  });

  it("formats durations >= 1 minute and < 1 hour in minutes and seconds", () => {
    assert.equal(
      formatRoundDuration("2026-11-05T05:00:00.000Z", "2026-11-05T05:01:00.000Z"),
      "1分钟",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T05:33:03.415Z", "2026-11-05T05:34:41.206Z"),
      "1分钟38秒",
    );
  });

  it("formats durations >= 1 hour with hours as maximum unit", () => {
    assert.equal(
      formatRoundDuration("2026-11-05T00:00:00.000Z", "2026-11-05T01:00:00.000Z"),
      "1小时",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T00:00:00.000Z", "2026-11-05T02:05:12.000Z"),
      "2小时5分钟12秒",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T00:00:00.000Z", "2026-11-06T03:00:00.000Z"),
      "27小时",
    );
  });

  it("returns empty string for invalid or inverted timestamps", () => {
    assert.equal(formatRoundDuration("", "2026-11-05T05:00:00.000Z"), "");
    assert.equal(formatRoundDuration("2026-11-05T05:00:00.000Z", ""), "");
    assert.equal(
      formatRoundDuration("2026-11-05T05:01:00.000Z", "2026-11-05T05:00:00.000Z"),
      "",
    );
  });
});

describe("formatTaskDuration", () => {
  const task = {
    status: "succeeded",
    iteration: 2,
    startedAt: "2026-11-05T00:00:00Z",
    endedAt: "2026-11-05T01:02:00Z",
    prompts: [
      { iteration: 1, at: "2026-11-05T00:00:00Z" },
      { iteration: 2, at: "2026-11-05T01:00:00Z" },
    ],
    outputs: [
      { iteration: 1, at: "2026-11-05T00:01:00Z" },
      { iteration: 2, at: "2026-11-05T01:02:00Z" },
    ],
  };

  it("sums rounds without the gap between them", () => {
    assert.equal(formatTaskDuration(task), "3分钟");
  });

  it("includes the current live round even before its first output", () => {
    for (const status of ["queued", "running", "blocked"]) {
      assert.equal(formatTaskDuration({ ...task, status, endedAt: undefined, outputs: task.outputs.slice(0, 1) },
        Date.parse("2026-11-05T01:00:30Z")), "1分钟30秒");
    }
    // A partial reply must not freeze the live round's duration.
    assert.equal(formatTaskDuration({ ...task, status: "running" },
      Date.parse("2026-11-05T01:03:00Z")), "4分钟");
  });

  it("counts a failed or stopped round without a reply using its end time", () => {
    for (const status of ["failed", "stopped"]) {
      assert.equal(formatTaskDuration({ ...task, status, outputs: task.outputs.slice(0, 1) }), "3分钟");
    }
  });

  it("supports legacy single-round tasks and archived tasks", () => {
    assert.equal(formatTaskDuration({ status: "succeeded", startedAt: task.startedAt,
      endedAt: "2026-11-05T00:01:00Z" }), "1分钟");
    assert.equal(formatTaskDuration({ ...task, status: "archived" }), "3分钟");
  });

  it("skips unknown or invalid rounds without counting idle time", () => {
    assert.equal(formatTaskDuration({ ...task, prompts: [task.prompts[0]], startedAt: undefined }), "1分钟");
    assert.equal(formatTaskDuration({ ...task, prompts: [{ iteration: 1, at: "invalid" }, task.prompts[1]],
      startedAt: undefined }), "2分钟");
    assert.equal(formatTaskDuration({ status: "succeeded" }), "");
    assert.equal(formatTaskDuration({ ...task, status: "draft" }), "");
    assert.equal(formatTaskDuration({ ...task, outputs: [{ iteration: 1, at: "2026-11-04T00:00:00Z" },
      { iteration: 2, at: "invalid" }] }), "");
  });

  it("sums milliseconds before rounding to seconds", () => {
    assert.equal(formatTaskDuration({ ...task,
      outputs: [{ iteration: 1, at: "2026-11-05T00:00:00.400Z" },
        { iteration: 2, at: "2026-11-05T01:00:00.400Z" }] }), "1秒");
  });
});
