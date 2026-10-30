import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Runner } from "./runners/types.js";
import { runners } from "./runners/index.js";
import {
  clearHandlesForTests,
  createDraft,
  hasPendingPatchForTests,
  removeTasks,
  startTask,
  stopTask,
} from "./manager.js";
import {
  deleteTasks,
  disableMemoryStoreForTests,
  enableMemoryStoreForTests,
  getTask,
  upsertTask,
} from "./store.js";

const originalPi = runners.pi;
let workspaceId = "";

function resultLine(text: string): string {
  return JSON.stringify({ type: "result", result: text });
}

function settlingRunner(text: string): Runner {
  return {
    start(_task, hooks) {
      hooks.onStatus({
        status: "running",
        startedAt: new Date().toISOString(),
        sessionId: "s4-sess",
      });
      hooks.onLog(resultLine(text));
      hooks.onStatus({
        status: "succeeded",
        exitCode: 0,
        endedAt: new Date().toISOString(),
      });
      return { stop() {} };
    },
  };
}

describe("pending output patch vs delete (S4)", () => {
  beforeEach(() => {
    workspaceId = enableMemoryStoreForTests();
    clearHandlesForTests();
    runners.pi = originalPi;
  });

  afterEach(() => {
    clearHandlesForTests();
    runners.pi = originalPi;
    disableMemoryStoreForTests();
  });

  it("natural end flushes the deferred patch before delete", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = settlingRunner("deferred-output-s4");
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-delete",
    });
    const started = await startTask(draft.id);
    assert.equal(started.status, "succeeded");
    assert.equal(started.output, "deferred-output-s4");
    assert.equal(hasPendingPatchForTests(started.id), false);

    const result = await removeTasks([started.id]);
    assert.deepEqual(result.deleted, [started.id]);
    assert.equal(getTask(started.id), undefined);

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    assert.equal(getTask(started.id), undefined);
  });

  it("a deferred patch does not rewrite a task reused under the same id", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({ status: "blocked", startedAt: new Date().toISOString() });
        hooks.onLog(resultLine("stale-output"));
        return { stop() {} };
      },
    };
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-reuse",
    });
    await startTask(draft.id);
    assert.equal(hasPendingPatchForTests(draft.id), true);
    const snapshot = getTask(draft.id);
    assert.ok(snapshot);
    await removeTasks([draft.id]);
    upsertTask({
      ...snapshot,
      status: "draft",
      output: "sentinel-keep",
      outputs: [],
      summary: "sentinel",
    });

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    const again = getTask(draft.id);
    assert.equal(again?.output, "sentinel-keep");
    assert.equal(again?.summary, "sentinel");
    assert.equal(again?.status, "draft");
    assert.equal(hasPendingPatchForTests(draft.id), false);
  });

  it("stop() during delete cannot leave a patch timer behind", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({
          status: "blocked",
          startedAt: new Date().toISOString(),
        });
        hooks.onLog(resultLine("before-stop"));
        return {
          stop() {
            hooks.onLog(resultLine("during-stop"));
          },
        };
      },
    };
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-blocked",
    });
    const started = await startTask(draft.id);
    assert.equal(started.status, "blocked");
    assert.equal(hasPendingPatchForTests(draft.id), true);

    const result = await removeTasks([draft.id]);
    assert.deepEqual(result.deleted, [draft.id]);
    assert.ok(result.stopped.includes(draft.id));
    assert.equal(hasPendingPatchForTests(draft.id), false);

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    assert.equal(getTask(draft.id), undefined);
  });

  it("deleteTasks drops a pending patch when removeTasks is not the caller", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({ status: "blocked", startedAt: new Date().toISOString() });
        hooks.onLog(resultLine("via-store"));
        return { stop() {} };
      },
    };
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-store-delete",
    });
    await startTask(draft.id);
    assert.equal(hasPendingPatchForTests(draft.id), true);

    assert.deepEqual(await deleteTasks([draft.id]), [draft.id]);
    assert.equal(getTask(draft.id), undefined);
    assert.equal(hasPendingPatchForTests(draft.id), false);

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    assert.equal(getTask(draft.id), undefined);
  });

  it("flushing a patch whose task was already removed does not throw", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({ status: "blocked", startedAt: new Date().toISOString() });
        hooks.onLog(resultLine("orphan-flush"));
        return { stop() {} };
      },
    };
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-orphan",
    });
    await startTask(draft.id);
    assert.equal(hasPendingPatchForTests(draft.id), true);

    // Drop the row without the delete hook so the timer is still armed.
    enableMemoryStoreForTests();
    assert.equal(getTask(draft.id), undefined);
    assert.equal(hasPendingPatchForTests(draft.id), true);

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    assert.equal(getTask(draft.id), undefined);
    assert.equal(hasPendingPatchForTests(draft.id), false);
  });

  it("stop still flushes a pending patch, and a refused delete leaves it queued", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({
          status: "running",
          startedAt: new Date().toISOString(),
          sessionId: "hold",
        });
        hooks.onLog(resultLine("flushed-on-stop"));
        hooks.onLog(
          JSON.stringify({
            type: "tool_execution_start",
            toolName: "agent",
            toolCallId: "job-1",
            args: { description: "bg-job" },
          }),
        );
        return { stop() {} };
      },
    };
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-stop",
    });
    const started = await startTask(draft.id);
    assert.equal(started.status, "running");
    assert.equal(hasPendingPatchForTests(draft.id), true);
    assert.equal(getTask(draft.id)?.output, undefined);

    const refused = await removeTasks([draft.id]);
    assert.deepEqual(refused.deleted, []);
    assert.equal(refused.skipped[0]?.id, draft.id);
    assert.equal(hasPendingPatchForTests(draft.id), true);

    const stopped = await stopTask(draft.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.output, "flushed-on-stop");
    assert.equal(stopped.sideJobs?.[0]?.id, "job-1");
    assert.equal(stopped.sideJobs?.[0]?.status, "stopped");
    assert.equal(hasPendingPatchForTests(draft.id), false);

    t.mock.timers.tick(1000);
    assert.equal(getTask(draft.id)?.output, "flushed-on-stop");
    assert.equal(getTask(draft.id)?.status, "stopped");
    assert.equal(getTask(draft.id)?.sideJobs?.[0]?.status, "stopped");
  });

  it("a late callback from a finished run cannot overwrite the task", async () => {
    let late: { onLog: (line: string) => void; onStatus: (p: object) => void } | undefined;
    runners.pi = {
      start(_task, hooks) {
        late = hooks;
        hooks.onStatus({
          status: "running",
          startedAt: new Date().toISOString(),
          sessionId: "run-1",
        });
        hooks.onLog(resultLine("first-run"));
        hooks.onStatus({
          status: "succeeded",
          exitCode: 0,
          endedAt: new Date().toISOString(),
        });
        return { stop() {} };
      },
    };
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "m4-stale",
    });
    const started = await startTask(draft.id);
    assert.equal(started.output, "first-run");
    assert.equal(started.sessionId, "run-1");
    late?.onLog(resultLine("stale-line"));
    late?.onStatus({ status: "running", output: "overwrite" });
    const after = getTask(draft.id);
    assert.equal(after?.status, "succeeded");
    assert.equal(after?.output, "first-run");
  });
});
