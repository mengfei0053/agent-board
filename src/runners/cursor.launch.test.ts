import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { _resetCliPathOverridesForTests } from "../cliPaths.js";
import { cursorRunner } from "./cursor.js";
import type { Task } from "../types.js";

describe("cursor launch failures (S6)", () => {
  it("fails the task instead of rejecting when the CLI path contains NUL", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);
    _resetCliPathOverridesForTests({ agent: "agent\0does-not-exist" });
    const statuses: string[] = [];
    const task = {
      id: "cur-nul",
      title: "nul",
      kind: "cursor",
      workspaceId: "ws",
      cwd: process.cwd(),
      prompt: "hi",
      iteration: 1,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    try {
      const handle = cursorRunner.start(task, {
        onStatus: (patch) => {
          if (patch.status) statuses.push(patch.status);
        },
        onLog: () => {},
      });
      await new Promise((r) => setTimeout(r, 50));
      handle.stop();
      assert.equal(rejections.length, 0);
      assert.ok(statuses.includes("failed"), `statuses=${statuses.join(",")}`);
    } finally {
      process.off("unhandledRejection", onRejection);
      _resetCliPathOverridesForTests({});
    }
  });
});
