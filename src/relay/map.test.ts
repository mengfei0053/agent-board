import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTerminalStatus, mapBoardTask, mapStatus, taskSignature, wireMappedTask } from "./map.js";
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
    assert.equal(mapped?.workspaceId, "w1");
    assert.equal(mapped?.updatedAt, Date.parse("2026-10-31T00:00:00.000Z"));
    assert.equal(mapBoardTask(makeTask({ status: "archived" })), null);
  });

  it("omits a missing or unusable workspace id and still maps the task", () => {
    assert.equal(mapBoardTask(makeTask({ workspaceId: "" }))?.workspaceId, undefined);
    assert.equal(mapBoardTask(makeTask({ workspaceId: "not a workspace" }))?.workspaceId, undefined);
    assert.equal(mapBoardTask(makeTask({ workspaceId: "ws_app" }))?.workspaceId, "ws_app");
  });

  it("changes signature when title, status, agent, or workspace changes", () => {
    const base = mapBoardTask(makeTask())!;
    assert.equal(taskSignature(base), taskSignature({ ...base }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, title: "Other" }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, status: "succeeded" }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, agent: "claude" }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, workspaceId: "ws_other" }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, workspaceId: undefined }));
    assert.notEqual(taskSignature(base), taskSignature({ ...base, output: "done" }));
  });

  it("puts a short preview on snapshots and the full card on evt.task", () => {
    const mapped = mapBoardTask(makeTask({
      prompt: "P".repeat(300),
      output: "O".repeat(300),
      iteration: 2,
      sessionId: "sess-123",
      cwd: "/tmp/repo",
      prompts: [{ iteration: 1, prompt: "first" }, { iteration: 2, prompt: "second" }],
      outputs: [{ iteration: 2, text: "answer" }],
      sideJobs: [{ id: "j1", kind: "monitor", title: "watch", status: "running" }],
      worktree: { path: "/tmp/wt", branch: "ab/phone", baseHead: "abc", owned: true },
    }))!;
    assert.equal(mapped.resumeCommand, "cd /tmp/repo && pi --session-id sess-123");
    assert.equal(mapped.worktreeBranch, "ab/phone");
    assert.equal(mapped.turns?.length, 2);
    const snap = wireMappedTask(mapped, "snapshot");
    assert.equal(snap.detail, undefined);
    assert.equal(snap.turns, undefined);
    assert.equal(String(snap.promptPreview).length <= 241, true);
    assert.equal(snap.prompt, undefined);
    const full = wireMappedTask(mapped, "full");
    assert.equal(full.detail, "full");
    assert.equal((full.turns as Array<{ output?: string }>)[1]?.output, "answer");
    assert.equal((full.sideJobs as Array<{ title: string }>)[0]?.title, "watch");
  });
});
