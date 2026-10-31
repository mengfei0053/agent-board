import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTerminalStatus, mapBoardTask, mapStatus, taskSignature } from "./map.js";
import { makeTask } from "./harness.js";

describe("relay map", () => {
  it("maps board statuses and drops archived", () => {
    assert.equal(mapStatus("draft"), "queued");
    assert.equal(mapStatus("queued"), "queued");
    assert.equal(mapStatus("running"), "running");
    assert.equal(mapStatus("blocked"), "paused");
    assert.equal(mapStatus("succeeded"), "succeeded");
    assert.equal(mapStatus("failed"), "failed");
    assert.equal(mapStatus("stopped"), "stopped");
    assert.equal(mapStatus("archived"), null);
    assert.equal(mapStatus("nope"), null);
    assert.equal(isTerminalStatus("stopped"), true);
    assert.equal(isTerminalStatus("paused"), false);
  });

  it("maps a board task onto the phone shape", () => {
    const mapped = mapBoardTask(makeTask({
      status: "blocked",
      kind: "codex",
      updatedAt: "2026-10-31T00:00:00.000Z",
    }));
    assert.equal(mapped?.status, "paused");
    assert.equal(mapped?.agent, "codex");
    assert.equal(mapped?.updatedAt, Date.parse("2026-10-31T00:00:00.000Z"));
    assert.equal(mapBoardTask(makeTask({ status: "archived" })), null);
  });

  it("changes signature when title, status, or agent changes", () => {
    const base = mapBoardTask(makeTask())!;
    assert.equal(taskSignature(base), taskSignature({ ...base }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, title: "Other" }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, status: "succeeded" }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, agent: "claude" }));
  });
});
