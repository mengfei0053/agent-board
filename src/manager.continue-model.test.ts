import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { continueTask, createDraft, clearHandlesForTests } from "./manager.js";
import { runners } from "./runners/index.js";
import {
  disableMemoryStoreForTests,
  enableMemoryStoreForTests,
  failNextPersistForTests,
  flushPersist,
  getTask,
  setPersistDryRunForTests,
  upsertTask,
} from "./store.js";
import type { Task } from "./types.js";

const originals = { ...runners };
let workspaceId = "";
let starts: Task[] = [];

describe("continue with a different model", () => {
  beforeEach(() => {
    workspaceId = enableMemoryStoreForTests();
    clearHandlesForTests();
    starts = [];
    for (const kind of Object.keys(runners) as Task["kind"][]) {
      runners[kind] = {
        start(task) {
          starts.push(task);
          return { stop() {} };
        },
      };
    }
  });

  afterEach(() => {
    clearHandlesForTests();
    Object.assign(runners, originals);
    disableMemoryStoreForTests();
  });

  async function seed(kind: Task["kind"] = "pi", patch: Partial<Task> = {}) {
    const draft = await createDraft({ kind, workspaceId, prompt: "original", model: "old-model" });
    upsertTask({
      ...draft,
      status: "succeeded",
      sessionId: "original-session",
      outputs: [{ iteration: 1, text: "previous answer" }],
      prompts: [{ iteration: 1, prompt: "original" }],
      ...patch,
    });
    return getTask(draft.id)!;
  }

  for (const kind of Object.keys(runners) as Task["kind"][]) {
    it(`${kind}: switches model without changing session, cwd, or history`, async () => {
      const task = await seed(kind);
      const continued = await continueTask(task.id, "follow up", "  next-model  ");
      assert.equal(continued.model, "next-model");
      assert.equal(continued.sessionId, task.sessionId);
      assert.equal(continued.cwd, task.cwd);
      assert.equal(continued.kind, task.kind);
      assert.equal(continued.workspaceId, task.workspaceId);
      assert.equal(continued.prompt, task.prompt);
      assert.deepEqual(continued.outputs, task.outputs);
      assert.deepEqual(continued.prompts?.[0], task.prompts?.[0]);
      assert.equal(continued.prompts?.[1]?.prompt, "follow up");
      assert.equal(continued.iteration, 2);
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.model, "next-model");
      assert.equal(starts[0]?.sessionId, "original-session");
    });
  }

  it("omitting the model preserves the selected model on subsequent rounds", async () => {
    const task = await seed();
    await continueTask(task.id, undefined, "next-model");
    upsertTask({ ...getTask(task.id)!, status: "stopped" });
    const next = await continueTask(task.id);
    assert.equal(next.model, "next-model");
    assert.equal(next.sessionId, task.sessionId);
    assert.equal(starts.at(-1)?.model, "next-model");
  });

  it("rejects unsafe changes before mutating history or launching a runner", async () => {
    for (const patch of [
      { sessionId: undefined },
      { status: "running" as const },
      { status: "queued" as const },
      { status: "blocked" as const },
      { status: "archived" as const },
      { status: "draft" as const },
    ]) {
      const task = await seed("pi", patch);
      const before = structuredClone(task);
      await assert.rejects(continueTask(task.id, "next", "next-model"));
      assert.deepEqual(getTask(task.id), before);
    }
    assert.equal(starts.length, 0);
  });

  it("rejects empty and oversized model overrides without side effects", async () => {
    const task = await seed();
    for (const model of ["", "   ", "x".repeat(201)]) {
      await assert.rejects(continueTask(task.id, "next", model));
      assert.deepEqual(getTask(task.id), task);
    }
    assert.equal(starts.length, 0);
  });

  it("serializes competing model changes, launching only one next round", async () => {
    const task = await seed();
    const results = await Promise.allSettled([
      continueTask(task.id, "first", "model-a"),
      continueTask(task.id, "second", "model-b"),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
    assert.equal(getTask(task.id)?.model, "model-a");
    assert.equal(getTask(task.id)?.sessionId, task.sessionId);
    assert.equal(getTask(task.id)?.iteration, 2);
    assert.equal(starts.length, 1);
  });

  it("does not spawn or commit a model switch when persistence fails", async () => {
    const task = await seed();
    await flushPersist();
    setPersistDryRunForTests(true);
    failNextPersistForTests("task", new Error("disk full"));
    await assert.rejects(continueTask(task.id, "next", "next-model"), /disk full/);
    assert.deepEqual(getTask(task.id), task);
    assert.equal(starts.length, 0);
  });

  it("does not retry with a new session or old model when the runner rejects resume", async () => {
    const task = await seed();
    runners.pi = {
      start(input, hooks) {
        starts.push(input);
        hooks.onStatus({ status: "failed", error: "session not found" });
        return { stop() {} };
      },
    };
    const result = await continueTask(task.id, "next", "unavailable-model");
    assert.equal(result.status, "failed");
    assert.equal(result.sessionId, task.sessionId);
    assert.equal(result.model, "unavailable-model");
    assert.equal(result.error, "session not found");
    assert.equal(starts.length, 1);
    assert.deepEqual(result.outputs, task.outputs);
  });
});
