import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeBoardTask } from "../../web/boardTaskMerge.js";

describe("mergeBoardTask", () => {
  it("does not replace an open detail body with a clipped summary", () => {
    const full = {
      id: "t1",
      prompt: "p".repeat(3000),
      output: "o".repeat(5000),
      outputs: [{ iteration: 1, text: "o".repeat(5000) }],
      prompts: [{ iteration: 1, prompt: "p".repeat(3000) }],
      status: "running",
    };
    const summary = {
      ...full,
      prompt: `${"p".repeat(2000)}…`,
      output: `${"o".repeat(2000)}…`,
      outputs: [{ iteration: 1, text: `${"o".repeat(2000)}…` }],
      prompts: [{ iteration: 1, prompt: `${"p".repeat(2000)}…` }],
      status: "succeeded",
      boardSummary: true,
      outputTruncated: true,
      promptTruncated: true,
    };
    const merged = mergeBoardTask(full, summary);
    assert.equal(merged.output, full.output);
    assert.equal(merged.prompt, full.prompt);
    assert.equal(merged.status, "succeeded");
    assert.equal(merged.boardSummary, false);
  });
});
