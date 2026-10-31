import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeStreamLogLine } from "./extractOutput.js";
import { MAX_LOG_LINE_CHARS } from "./logRetention.js";
import {
  clearHandlesForTests,
  createDraft,
  refreshOutputFromLogs,
  startTask,
} from "./manager.js";
import { runners } from "./runners/index.js";
import { spawnLogged } from "./runners/common.js";
import {
  disableMemoryStoreForTests,
  enableMemoryStoreForTests,
  getTask,
  readLogTail,
} from "./store.js";

const originalPi = runners.pi;
let workspaceId = "";

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 5_000) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function pipeScript(source: string) {
  return {
    start(task: { id: string; cwd: string }, hooks: Parameters<typeof spawnLogged>[3]) {
      return spawnLogged(process.execPath, ["-e", source], task.cwd, hooks, {
        cliKind: "pi",
        getStatus: () => getTask(task.id)?.status ?? "running",
      });
    },
  };
}

describe("stderr does not become task output (R2-M5)", () => {
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

  it("keeps a later stderr result out of output and outputs[]", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({ type: 'result', result: 'from-out' }) + '\\n');",
      "process.stderr.write(JSON.stringify({ type: 'result', result: 'from-err' }) + '\\n');",
      "process.stderr.write('plain stderr noise\\n');",
    ].join("");
    runners.pi = pipeScript(script);
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "streams",
      title: "streams",
    });
    await startTask(draft.id);
    await waitUntil(() => {
      const status = getTask(draft.id)?.status;
      return status === "succeeded" || status === "failed";
    }, "mixed streams to settle");

    const task = getTask(draft.id);
    assert.equal(task?.status, "succeeded");
    assert.equal(task?.output, "from-out");
    assert.deepEqual(
      task?.outputs?.map((o) => o.text),
      ["from-out"],
    );

    const lines = readLogTail(draft.id, 80);
    const stderr = lines
      .map((line) => decodeStreamLogLine(line))
      .filter((row): row is { stream: "stderr"; line: string } => row?.stream === "stderr");
    assert.ok(stderr.some((row) => row.line.includes("from-err")));
    assert.ok(stderr.some((row) => row.line.includes("plain stderr noise")));
    assert.ok(
      lines.some((line) => decodeStreamLogLine(line)?.stream === "stdout" && line.includes("from-out")),
    );

    const reloaded = refreshOutputFromLogs(draft.id);
    assert.equal(reloaded?.output, "from-out");
    assert.deepEqual(
      reloaded?.outputs?.map((o) => o.text),
      ["from-out"],
    );
  });

  it("does not adopt stderr result or plain text when stdout has no assistant body", async () => {
    const script = [
      "process.stderr.write(JSON.stringify({ type: 'result', result: 'from-err' }) + '\\n');",
      "process.stderr.write('plain stderr noise\\n');",
      "process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');",
    ].join("");
    runners.pi = pipeScript(script);
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "err-only",
      title: "err-only",
    });
    await startTask(draft.id);
    await waitUntil(() => {
      const status = getTask(draft.id)?.status;
      return status === "succeeded" || status === "failed";
    }, "stderr-only to settle");

    const task = getTask(draft.id);
    assert.equal(task?.status, "succeeded");
    assert.equal(task?.output, undefined);
    assert.equal(task?.outputs?.length ?? 0, 0);
    assert.equal(task?.summary?.includes("from-err") ?? false, false);
    assert.equal(task?.summary?.includes("plain stderr noise") ?? false, false);

    const reloaded = refreshOutputFromLogs(draft.id);
    assert.equal(reloaded?.output, undefined);
    assert.equal(reloaded?.outputs?.some((o) => /from-err|plain stderr noise/.test(o.text)) ?? false, false);
  });

  it("keeps a long stdout answer on the task while the stored log line stays bounded", async () => {
    const answer = "B".repeat(12_000);
    runners.pi = {
      start(_task, hooks) {
        hooks.onStatus({ status: "running", pid: 7, startedAt: new Date().toISOString() });
        hooks.onLog(JSON.stringify({ type: "result", result: answer }), "stdout");
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
      prompt: "long",
      title: "long",
    });
    const started = await startTask(draft.id);
    assert.equal(started.status, "succeeded");
    assert.equal(started.output, answer);
    assert.equal(started.outputs?.[0]?.text, answer);

    const lines = readLogTail(draft.id, 80);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(line.length <= MAX_LOG_LINE_CHARS);
      assert.equal(line.includes(answer), false);
    }
    const reloaded = refreshOutputFromLogs(draft.id);
    assert.equal(reloaded?.output, answer);
    assert.equal(reloaded?.outputs?.[0]?.text, answer);
  });
});
