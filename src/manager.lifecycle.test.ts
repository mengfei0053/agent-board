import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./runners/types.js";
import { runners } from "./runners/index.js";
import {
  clearHandlesForTests,
  createDraft,
  moveTask,
  startTask,
} from "./manager.js";
import {
  appendLog,
  disableMemoryStoreForTests,
  durableWaiterCountForTests,
  enableMemoryStoreForTests,
  getTask,
  readLogTail,
  setDurableDelayForTests,
  upsertTask,
} from "./store.js";

const originalPi = runners.pi;
let workspaceId = "";

describe("task operation lock and fresh runs", () => {
  beforeEach(() => {
    workspaceId = enableMemoryStoreForTests();
    clearHandlesForTests();
    runners.pi = originalPi;
  });

  afterEach(() => {
    setDurableDelayForTests(null);
    clearHandlesForTests();
    runners.pi = originalPi;
    disableMemoryStoreForTests();
  });

  it("does not leave a runner running after move-to-draft overlaps start", async () => {
    const events: string[] = [];
    const held: Runner = {
      start(_task, hooks) {
        events.push("start");
        hooks.onStatus({ status: "running", pid: 9, startedAt: new Date().toISOString() });
        return {
          stop() {
            events.push("stop");
          },
        };
      },
    };
    runners.pi = held;
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "overlap",
      title: "overlap",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDurableDelayForTests(gate);
    const startP = startTask(draft.id);
    const deadline = Date.now() + 1000;
    while (durableWaiterCountForTests() < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(durableWaiterCountForTests(), 1);
    const moveP = moveTask(draft.id, "draft");
    setDurableDelayForTests(null);
    release();
    await startP;
    await moveP;
    assert.equal(getTask(draft.id)?.status, "draft");
    assert.deepEqual(events, ["start", "stop"]);
  });

  it("fresh start resets iteration and drops prior round logs", async () => {
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({ status: "running", pid: 3 });
        return { stop() {} };
      },
    };
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "original",
      title: "fresh",
    });
    const cur = getTask(draft.id)!;
    upsertTask({
      ...cur,
      iteration: 3,
      status: "stopped",
      prompts: [
        { iteration: 1, prompt: "original", at: cur.createdAt },
        { iteration: 2, prompt: "old-continue", at: cur.createdAt },
        { iteration: 3, prompt: "older", at: cur.createdAt },
      ],
      outputs: [{ iteration: 2, text: "old answer" }],
      output: "old answer",
    });
    appendLog(draft.id, JSON.stringify({ type: "continue", iteration: 2, prompt: "old-continue" }));
    appendLog(draft.id, JSON.stringify({ type: "result", result: "old answer" }));
    const started = await startTask(draft.id);
    assert.equal(started.iteration, 1);
    assert.equal(started.prompts?.length, 1);
    assert.equal(started.prompts?.[0]?.prompt, "original");
    assert.equal(started.output, undefined);
    const lines = readLogTail(draft.id, 50);
    assert.equal(lines.some((l) => l.includes("old-continue")), false);
    assert.ok(lines.some((l) => l.includes('"start"')));
  });

  it("rejects start when cwd is no longer an allowed directory", async () => {
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "cwd",
      title: "cwd",
    });
    const file = join(mkdtempSync(join(tmpdir(), "ab-cwd-")), "not-a-dir");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "x");
    upsertTask({ ...getTask(draft.id)!, cwd: file, status: "stopped" });
    await assert.rejects(startTask(draft.id), /not a directory|not found|outside/);
    assert.notEqual(getTask(draft.id)?.status, "queued");
  });
});
