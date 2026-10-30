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

  it("delete disarms the deferred patch so the timer cannot throw", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = settlingRunner("deferred-output-s4");
    const draft = createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-delete",
    });
    const started = startTask(draft.id);
    assert.equal(started.status, "succeeded");
    assert.equal(hasPendingPatchForTests(started.id), true);

    const result = removeTasks([started.id]);
    assert.deepEqual(result.deleted, [started.id]);
    assert.equal(getTask(started.id), undefined);
    assert.equal(hasPendingPatchForTests(started.id), false);

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    assert.equal(getTask(started.id), undefined);
    assert.equal(hasPendingPatchForTests(started.id), false);
  });

  it("a deferred patch does not rewrite a task reused under the same id", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = settlingRunner("stale-output");
    const draft = createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-reuse",
    });
    startTask(draft.id);
    assert.equal(hasPendingPatchForTests(draft.id), true);
    const snapshot = getTask(draft.id);
    assert.ok(snapshot);
    removeTasks([draft.id]);
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

  it("stop() during delete cannot leave a patch timer behind", (t) => {
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
    const draft = createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-blocked",
    });
    const started = startTask(draft.id);
    assert.equal(started.status, "blocked");
    assert.equal(hasPendingPatchForTests(draft.id), true);

    const result = removeTasks([draft.id]);
    assert.deepEqual(result.deleted, [draft.id]);
    assert.ok(result.stopped.includes(draft.id));
    assert.equal(hasPendingPatchForTests(draft.id), false);

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    assert.equal(getTask(draft.id), undefined);
  });

  it("deleteTasks drops a pending patch when removeTasks is not the caller", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = settlingRunner("via-store");
    const draft = createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-store-delete",
    });
    startTask(draft.id);
    assert.equal(hasPendingPatchForTests(draft.id), true);

    assert.deepEqual(deleteTasks([draft.id]), [draft.id]);
    assert.equal(getTask(draft.id), undefined);
    assert.equal(hasPendingPatchForTests(draft.id), false);

    assert.doesNotThrow(() => {
      t.mock.timers.tick(1000);
    });
    assert.equal(getTask(draft.id), undefined);
  });

  it("flushing a patch whose task was already removed does not throw", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = settlingRunner("orphan-flush");
    const draft = createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-orphan",
    });
    startTask(draft.id);
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

  it("stop still flushes a pending patch, and a refused delete leaves it queued", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({
          status: "running",
          startedAt: new Date().toISOString(),
          sessionId: "hold",
        });
        hooks.onLog(resultLine("flushed-on-stop"));
        return { stop() {} };
      },
    };
    const draft = createDraft({
      kind: "pi",
      workspaceId,
      prompt: "hello",
      title: "s4-stop",
    });
    const started = startTask(draft.id);
    assert.equal(started.status, "running");
    assert.equal(hasPendingPatchForTests(draft.id), true);
    assert.equal(getTask(draft.id)?.output, undefined);

    const refused = removeTasks([draft.id]);
    assert.deepEqual(refused.deleted, []);
    assert.equal(refused.skipped[0]?.id, draft.id);
    assert.equal(hasPendingPatchForTests(draft.id), true);

    const stopped = stopTask(draft.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.output, "flushed-on-stop");
    assert.equal(hasPendingPatchForTests(draft.id), false);

    t.mock.timers.tick(1000);
    assert.equal(getTask(draft.id)?.output, "flushed-on-stop");
    assert.equal(getTask(draft.id)?.status, "stopped");
  });
});
