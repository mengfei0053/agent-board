import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runners } from "./runners/index.js";
import type { Runner } from "./runners/types.js";
import {
  archiveTerminalTask,
  clearHandlesForTests,
  continueTask,
  createDraft,
  moveTask,
  startTask,
  stopTask,
} from "./manager.js";
import {
  disableMemoryStoreForTests,
  durableWaiterCountForTests,
  enableMemoryStoreForTests,
  getTask,
  setDurableDelayForTests,
  upsertTask,
} from "./store.js";
import { ArchivedReadonlyError } from "./taskErrors.js";

const originalPi = runners.pi;
let workspaceId = "";
const quiet: Runner = {
  start() {
    return { stop() {} };
  },
};

describe("archived task mutations", () => {
  beforeEach(() => {
    workspaceId = enableMemoryStoreForTests();
    clearHandlesForTests();
    runners.pi = quiet;
  });

  afterEach(() => {
    setDurableDelayForTests(null);
    clearHandlesForTests();
    runners.pi = originalPi;
    disableMemoryStoreForTests();
  });

  it("rejects continue, stop, and start on an archived task", async () => {
    const task = await archivedTask();
    await assert.rejects(continueTask(task.id, "more"), (err) => err instanceof ArchivedReadonlyError);
    await assert.rejects(stopTask(task.id), (err) => err instanceof ArchivedReadonlyError);
    await assert.rejects(startTask(task.id), (err) => err instanceof ArchivedReadonlyError);
    const after = getTask(task.id);
    assert.equal(after?.status, "archived");
    assert.equal(after?.output, "kept");
    assert.equal(after?.prompts?.[0]?.prompt, "original");
  });

  it("still stores the omitted-prompt default for a stopped task", async () => {
    const task = await stoppedTask();
    const continued = await continueTask(task.id);
    assert.equal(continued.prompts?.some((turn) => turn.prompt === "请基于当前上下文继续完成任务"), true);
    assert.notEqual(continued.status, "archived");
  });

  it("archives only a terminal task and leaves running, draft, and archived rows alone", async () => {
    const stopped = await stoppedTask();
    const archived = await archiveTerminalTask(stopped.id);
    assert.equal(archived.taskId, stopped.id);
    assert.equal(getTask(stopped.id)?.status, "archived");
    assert.equal(getTask(stopped.id)?.lastEvent, "archive:stopped");

    const running = await stoppedTask("running");
    await upsertTask({ ...getTask(running.id)!, status: "running" });
    await assert.rejects(archiveTerminalTask(running.id), /task is still running/);
    assert.equal(getTask(running.id)?.status, "running");

    const draft = await createDraft({ kind: "pi", workspaceId, prompt: "d", title: "draft" });
    await assert.rejects(archiveTerminalTask(draft.id), /draft cannot be archived/);
    assert.equal(getTask(draft.id)?.status, "draft");

    await assert.rejects(archiveTerminalTask(stopped.id), (err) => err instanceof ArchivedReadonlyError);
    assert.equal(getTask(stopped.id)?.status, "archived");
  });

  it("does not archive a task that continued while the archive waited on the lock", async () => {
    const task = await stoppedTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDurableDelayForTests(gate);
    const continued = continueTask(task.id, "keep going");
    const deadline = Date.now() + 1000;
    while (durableWaiterCountForTests() < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(durableWaiterCountForTests(), 1);
    const archived = archiveTerminalTask(task.id);
    setDurableDelayForTests(null);
    release();
    await continued;
    await assert.rejects(archived, /task is still running/);
    assert.notEqual(getTask(task.id)?.status, "archived");
  });

  it("does not continue a task that was archived while continue waited on the lock", async () => {
    const task = await stoppedTask();
    let starts = 0;
    runners.pi = {
      start() {
        starts += 1;
        return { stop() {} };
      },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDurableDelayForTests(gate);
    const archived = archiveTerminalTask(task.id);
    const deadline = Date.now() + 1000;
    while (durableWaiterCountForTests() < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const continued = continueTask(task.id, "too late");
    setDurableDelayForTests(null);
    release();
    await archived;
    await assert.rejects(continued, (err) => err instanceof ArchivedReadonlyError);
    assert.equal(getTask(task.id)?.status, "archived");
    assert.equal(starts, 0);
  });

  it("keeps the web move-to-archive path for a running card", async () => {
    const task = await stoppedTask();
    await upsertTask({ ...getTask(task.id)!, status: "running" });
    const moved = await moveTask(task.id, "archived");
    assert.equal(moved.status, "archived");
    assert.equal(moved.lastEvent, "archive:stopped");
  });
});

async function stoppedTask(title = "stopped"): Promise<{ id: string }> {
  const draft = await createDraft({ kind: "pi", workspaceId, prompt: "original", title });
  const stored = getTask(draft.id);
  if (!stored) throw new Error("missing draft");
  upsertTask({ ...stored, status: "stopped", output: "kept", prompts: [{ iteration: 1, prompt: "original" }] });
  return draft;
}

async function archivedTask(): Promise<{ id: string }> {
  const task = await stoppedTask("archived");
  await archiveTerminalTask(task.id);
  return task;
}
