import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUndeletableStatus } from "./manager.js";
import type { TaskStatus } from "./types.js";

describe("isUndeletableStatus", () => {
  it("blocks queued and running only", () => {
    const blocked: TaskStatus[] = ["queued", "running"];
    const allowed: TaskStatus[] = [
      "draft",
      "blocked",
      "succeeded",
      "failed",
      "stopped",
      "archived",
    ];
    for (const s of blocked) {
      assert.equal(isUndeletableStatus(s), true, s);
    }
    for (const s of allowed) {
      assert.equal(isUndeletableStatus(s), false, s);
    }
  });
});
