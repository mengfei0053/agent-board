import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetQuickPromptsForTests,
  getQuickPromptSettings,
  parseQuickPromptsJson,
} from "./quickPrompts.js";

afterEach(() => {
  _resetQuickPromptsForTests([]);
});

describe("parseQuickPromptsJson", () => {
  it("handles empty / invalid", () => {
    assert.deepEqual(parseQuickPromptsJson(""), []);
    assert.deepEqual(parseQuickPromptsJson("{}"), []);
    assert.deepEqual(parseQuickPromptsJson("["), []);
  });

  it("keeps valid entries, drops junk, dedupes ids", () => {
    const out = parseQuickPromptsJson(
      JSON.stringify([
        { id: "a1", label: "  短标  ", content: "hello" },
        { id: "a1", label: "dup", content: "other" },
        { label: "", content: "x" },
        { label: "ok", content: "  " },
        null,
        { label: "L2", content: "body2" },
      ]),
    );
    assert.ok(out.length >= 2);
    assert.equal(out[0].label, "短标");
    assert.equal(out[0].content, "hello");
    assert.equal(out[0].id, "a1");
    // duplicate id regenerated
    assert.notEqual(out[1].id, "a1");
    assert.ok(out.some((x) => x.label === "L2" && x.content === "body2"));
  });

  it("caps at 50", () => {
    const arr = Array.from({ length: 60 }, (_, i) => ({
      id: `id${i}`,
      label: `L${i}`,
      content: `c${i}`,
    }));
    assert.equal(parseQuickPromptsJson(JSON.stringify(arr)).length, 50);
  });
});

describe("getQuickPromptSettings", () => {
  it("returns a copy of in-memory prompts", () => {
    _resetQuickPromptsForTests([
      { id: "1", label: "A", content: "aaa" },
    ]);
    const a = getQuickPromptSettings();
    a.quickPrompts[0].label = "mutated";
    assert.equal(getQuickPromptSettings().quickPrompts[0].label, "A");
  });
});
