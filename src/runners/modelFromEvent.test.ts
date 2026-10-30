import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelFromJsonLine } from "./modelFromEvent.js";

describe("modelFromJsonLine", () => {
  it("returns undefined for invalid", () => {
    assert.equal(modelFromJsonLine("x"), undefined);
    assert.equal(modelFromJsonLine("{}"), undefined);
  });

  it("reads model from several event shapes", () => {
    assert.equal(
      modelFromJsonLine(JSON.stringify({ model: " gpt-4.1 " })),
      "gpt-4.1",
    );
    assert.equal(
      modelFromJsonLine(
        JSON.stringify({ type: "system", model: "claude-sonnet" }),
      ),
      "claude-sonnet",
    );
    assert.equal(
      modelFromJsonLine(
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-opus" },
        }),
      ),
      "claude-opus",
    );
    assert.equal(
      modelFromJsonLine(JSON.stringify({ type: "result", model: "cursor-m" })),
      "cursor-m",
    );
    assert.equal(
      modelFromJsonLine(
        JSON.stringify({
          type: "turn_context",
          payload: { model: "codex-m" },
        }),
      ),
      "codex-m",
    );
  });
});
