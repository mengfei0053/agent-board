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

  it("continues an archived task and can stop the next run", async () => {
    const task = await archivedTask();
    const continued = await continueTask(task.id, "more");
    assert.equal(continued.status, "queued");
    assert.equal(continued.iteration, 2);
    assert.equal(continued.sessionId, "original-session");
    assert.equal(continued.outputs?.[0]?.text, "kept");
    assert.equal(continued.prompts?.[0]?.prompt, "original");
    assert.equal(continued.prompts?.[1]?.prompt, "more");
    await assert.rejects(startTask(task.id), /task is already running/);
    await stopTask(task.id);
    assert.equal(getTask(task.id)?.status, "stopped");
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

  it("continues a task that was archived while continue waited on the lock", async () => {
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
    const result = await continued;
    assert.equal(result.status, "queued");
    assert.equal(result.prompts?.[1]?.prompt, "too late");
    assert.equal(starts, 1);
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
  upsertTask({
    ...stored,
    status: "stopped",
    sessionId: "original-session",
    output: "kept",
    outputs: [{ iteration: 1, text: "kept" }],
    prompts: [{ iteration: 1, prompt: "original" }],
  });
  return draft;
}

async function archivedTask(): Promise<{ id: string }> {
  const task = await stoppedTask("archived");
  await archiveTerminalTask(task.id);
  return task;
}
