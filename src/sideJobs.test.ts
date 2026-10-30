import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  finalizeRunningSideJobs,
  mergeSideJobs,
  sideJobsFromLogLine,
} from "./sideJobs.js";

const at = "2026-01-01T00:00:00.000Z";

describe("sideJobsFromLogLine", () => {
  it("returns [] for non-json / irrelevant", () => {
    assert.deepEqual(sideJobsFromLogLine("plain", at), []);
    assert.deepEqual(sideJobsFromLogLine("{", at), []);
    assert.deepEqual(
      sideJobsFromLogLine(JSON.stringify({ type: "result", result: "ok" }), at),
      [],
    );
  });

  it("handles pi tool_execution_start/end for agent tools", () => {
    const start = sideJobsFromLogLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "Agent",
        toolCallId: "t1",
        args: { description: "research X", subagent_type: "explore" },
      }),
      at,
    );
    assert.equal(start.length, 1);
    assert.equal(start[0].id, "t1");
    assert.equal(start[0].kind, "agent");
    assert.equal(start[0].status, "running");
    assert.match(start[0].title || "", /research X/);

    const end = sideJobsFromLogLine(
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "Agent",
        toolCallId: "t1",
        result: { status: "completed" },
      }),
      at,
    );
    assert.equal(end[0].status, "succeeded");
    assert.equal(end[0].endedAt, at);
  });

  it("classifies background bash and monitor", () => {
    const bg = sideJobsFromLogLine(
      JSON.stringify({
        type: "tool_start",
        name: "Bash",
        id: "b1",
        input: { command: "sleep 10", run_in_background: true },
      }),
      at,
    );
    assert.equal(bg[0]?.kind, "background");

    const mon = sideJobsFromLogLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "Await",
        toolCallId: "m1",
        args: { description: "wait job" },
      }),
      at,
    );
    assert.equal(mon[0]?.kind, "monitor");
  });

  it("walks claude assistant tool_use blocks", () => {
    const updates = sideJobsFromLogLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu1",
              name: "Task",
              input: { prompt: "subtask" },
            },
          ],
        },
      }),
      at,
    );
    assert.equal(updates[0]?.kind, "task");
    assert.equal(updates[0]?.title, "subtask");
  });
});

describe("mergeSideJobs / finalizeRunningSideJobs", () => {
  it("creates and updates jobs; returns null when unchanged", () => {
    assert.equal(mergeSideJobs(undefined, []), null);
    const first = mergeSideJobs(undefined, [
      {
        id: "t1",
        kind: "agent",
        title: "A",
        status: "running",
        startedAt: at,
      },
    ]);
    assert.ok(first);
    assert.equal(first!.length, 1);

    const second = mergeSideJobs(first!, [
      { id: "t1", status: "succeeded", endedAt: at },
    ]);
    assert.equal(second![0].status, "succeeded");
    assert.equal(second![0].title, "A");

    assert.equal(
      mergeSideJobs(second!, [{ id: "t1", status: "succeeded", endedAt: at }]),
      null,
    );
  });

  it("finalizes running/unknown side jobs", () => {
    assert.equal(finalizeRunningSideJobs(undefined, at), null);
    const jobs = [
      { id: "1", kind: "agent" as const, title: "a", status: "running" as const },
      {
        id: "2",
        kind: "task" as const,
        title: "b",
        status: "succeeded" as const,
        endedAt: at,
      },
      { id: "3", kind: "monitor" as const, title: "c", status: "unknown" as const },
    ];
    const next = finalizeRunningSideJobs(jobs, "end", "stopped");
    assert.ok(next);
    assert.equal(next!.find((j) => j.id === "1")?.status, "stopped");
    assert.equal(next!.find((j) => j.id === "2")?.status, "succeeded");
    assert.equal(next!.find((j) => j.id === "3")?.endedAt, "end");
    assert.equal(finalizeRunningSideJobs(next!, at), null);
  });
});
