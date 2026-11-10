import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { _resetCliPathOverridesForTests } from "../cliPaths.js";
import type { Task } from "../types.js";
import { piRunner } from "./pi.js";

const quotaError = "Antigravity: Individual quota reached. Resets in 1h21m23s. (429: you can retry your request)";
const failedMessage = { role: "assistant", stopReason: "error", errorMessage: quotaError, content: [] };
const successMessage = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
const settled = { type: "agent_settled", aborted: false };

async function runEvents(events: unknown[], options: { tail?: boolean; stderr?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-pi-errors-"));
  const cli = join(dir, "pi");
  // Only a local mock process: no real model, database, or board API.
  writeFileSync(cli, `#!${process.execPath}
const events = ${JSON.stringify(events)};
const stream = process.${options.stderr ? "stderr" : "stdout"};
process.stdin.resume();
process.stdin.once("data", () => {
  stream.write(events.map(e => JSON.stringify(e)).join("\\n") + ${options.tail ? '""' : '"\\n"'});
});
`, { mode: 0o755 });
  _resetCliPathOverridesForTests({ pi: cli });
  const task = {
    id: "pi-errors", title: "errors", kind: "pi", workspaceId: "ws", cwd: dir,
    prompt: "test", iteration: 1, status: "queued",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as Task;
  const statuses: Array<Partial<Task>> = [];
  const logs: string[] = [];
  const handle = piRunner.start(task, {
    onStatus: (patch) => { statuses.push(patch); Object.assign(task, patch); },
    onLog: (line) => logs.push(line),
  });
  if (options.tail || options.stderr) handle.endStdin?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handle.settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mock CLI did not settle")), 5000);
      }),
    ]);
    return { task, statuses, logs };
  } finally {
    clearTimeout(timer);
    await handle.stopAndWait?.(100);
    _resetCliPathOverridesForTests({});
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pi model failures", () => {
  it("fails on exhausted retries despite exit zero and passive UI events", async () => {
    const { task, statuses, logs } = await runEvents([
      { type: "agent_start" },
      { type: "turn_end", message: failedMessage },
      { type: "extension_ui_request", method: "setStatus", statusText: "LSP Active" },
      { type: "agent_end", messages: [failedMessage], willRetry: false },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: quotaError },
      settled,
      { type: "extension_ui_request", method: "setWidget", widgetKey: "tasks" },
    ]);
    assert.equal(task.status, "failed");
    assert.equal(task.error, quotaError);
    assert.equal(task.exitCode, 0);
    assert.ok(task.endedAt);
    assert.ok(logs.some(line => line.includes('"type":"agent_settled"')));
    assert.equal(statuses.filter(p => p.status === "failed").length, 1);
    assert.equal(statuses.some(p => p.status === "succeeded"), false);
  });

  for (const event of [
    { type: "message_end", message: failedMessage },
    { type: "turn_end", message: failedMessage },
    { type: "agent_end", messages: [successMessage, failedMessage], willRetry: false },
    { type: "auto_retry_end", success: false, finalError: quotaError },
  ]) {
    it(`recognizes ${event.type} independently`, async () => {
      const { task } = await runEvents([event, settled]);
      assert.equal(task.status, "failed");
      assert.equal(task.error, quotaError);
    });
  }

  it("keeps a recovered retry successful without an early terminal failure", async () => {
    const { task, statuses } = await runEvents([
      { type: "turn_end", message: failedMessage },
      { type: "agent_end", messages: [failedMessage], willRetry: true },
      { type: "auto_retry_start", attempt: 1 },
      { type: "agent_start" },
      { type: "turn_end", message: successMessage },
      { type: "agent_end", messages: [failedMessage, successMessage] },
      { type: "auto_retry_end", success: true }, settled,
    ]);
    assert.equal(task.status, "succeeded");
    assert.equal(task.error, undefined);
    assert.equal(statuses.some(p => p.status === "failed"), false);
  });

  it("uses only the latest assistant outcome, not historical errors or tool failures", async () => {
    const { task } = await runEvents([
      { type: "agent_end", messages: [failedMessage, successMessage, { role: "toolResult", isError: true }] }, settled,
    ]);
    assert.equal(task.status, "succeeded");
  });

  it("supplies a fallback for errors with no message", async () => {
    const { task } = await runEvents([
      { type: "turn_end", message: { role: "assistant", stopReason: "error" } }, settled,
    ]);
    assert.equal(task.status, "failed");
    assert.match(task.error || "", /pi.*error/i);
  });

  it("recognizes non-quota model errors too", async () => {
    const { task } = await runEvents([
      { type: "turn_end", message: { ...failedMessage, errorMessage: "Invalid API key" } }, settled,
    ]);
    assert.equal(task.status, "failed");
    assert.equal(task.error, "Invalid API key");
  });

  it("recognizes an error in an unterminated final stdout line", async () => {
    const { task } = await runEvents([{ type: "turn_end", message: failedMessage }], { tail: true });
    assert.equal(task.status, "failed");
    assert.equal(task.error, quotaError);
  });

  it("ignores quoted provider errors in tool results and successful assistant text", async () => {
    const { task } = await runEvents([
      ...Array.from({ length: 6 }, () => ({ type: "tool_execution_end", result: { content: [{ type: "text", text: `Error: exceeded retry limit ${quotaError}` }] } })),
      { type: "turn_end", message: { ...successMessage, content: [{ type: "text", text: quotaError }] } }, settled,
    ]);
    assert.equal(task.status, "succeeded");
  });

  it("ignores protocol-shaped stderr", async () => {
    const { task } = await runEvents([{ type: "turn_end", message: failedMessage }], { stderr: true });
    assert.equal(task.status, "succeeded");
  });
});
