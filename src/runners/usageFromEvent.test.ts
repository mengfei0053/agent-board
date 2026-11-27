import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUsageParser } from "./usageFromEvent.js";

const result = {
  type: "result", uuid: "r1", total_cost_usd: 0.0123, num_turns: 4,
  modelUsage: { opus: {} }, usage: {
    input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 7 },
  },
};
const turn = { type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 11, output_tokens: 4 } };
const msg = { role: "assistant", responseId: "m1", model: "llm", usage: {
  input: 2, output: 7, reasoning: 3, cacheRead: 11, cacheWrite: 4, totalTokens: 24,
  cost: { total: 0.03, totalFromProvider: true },
} };

describe("runner usage parsers", () => {
  it("uses Claude's result only, with fresh input, distinct cache buckets and no request estimate", () => {
    const parse = createUsageParser("claude");
    assert.equal(parse({ ...result, type: "assistant" }), undefined);
    assert.deepEqual(parse(result), { key: "claude:result:r1", input: 2, output: 3, cacheRead: 11,
      cacheWrite: 7, total: 23, requests: null, costUsd: 0.0123, model: "opus" });
    assert.equal(parse(result), undefined);
    assert.equal(createUsageParser("claude")(result)?.key, "claude:result:r1");
  });

  it("does not convert missing, negative, fractional, string or overflowing counts into tokens", () => {
    const parse = createUsageParser("claude");
    for (const usage of [undefined, [], null, "bad", {}, { input_tokens: 2 ** 53 }]) {
      assert.equal(parse({ type: "result", usage }), undefined);
    }
    const partial = { type: "result", total_cost_usd: -2, modelUsage: { a: {}, b: {} }, usage: {
      input_tokens: -1, output_tokens: 0, cache_read_input_tokens: "5", cache_creation_input_tokens: 0.5,
    } };
    assert.deepEqual(parse(partial), { key: "claude:result:summary", input: null, output: 0,
      cacheRead: null, cacheWrite: null, total: null, costUsd: null, requests: null });
    assert.equal(parse(partial), undefined);
  });

  it("Codex subtracts cached input once and distinguishes id-less turns even with equal usage", () => {
    const parse = createUsageParser("codex");
    parse({ type: "turn.started" });
    const first = parse(turn);
    assert.deepEqual(first, { key: "codex:turn:seq:1", input: 1, output: 4, cacheRead: 11,
      cacheWrite: null, total: 16, requests: null, costUsd: null });
    assert.equal(parse(turn), undefined);
    parse({ type: "turn.started" });
    assert.notEqual(parse(turn)?.key, first.key);
    const bare = createUsageParser("codex");
    assert.notEqual(bare(turn)?.key, bare(turn)?.key);
    const withId = { ...turn, turn_id: "t" };
    assert.ok(parse(withId));
    assert.equal(parse(withId), undefined);
  });

  it("does not guess fresh Codex input with missing or inconsistent cached counts", () => {
    for (const cached_input_tokens of [undefined, -1, 20, "3"]) {
      const row = createUsageParser("codex")({ ...turn, usage: { ...turn.usage, cached_input_tokens } });
      assert.equal(row?.input, null);
      assert.equal(row?.cacheRead, null);
      assert.equal(row?.total, 16);
    }
  });

  it("Pi uses only final assistant messages, not turn/agent echoes or reasoning subtotals", () => {
    const parse = createUsageParser("pi");
    for (const type of ["message_update", "turn_end", "agent_end"]) assert.equal(parse({ type, message: msg }), undefined);
    assert.equal(parse({ type: "message_end", message: { ...msg, role: "toolResult" } }), undefined);
    const end = { type: "message_end", message: msg };
    assert.deepEqual(parse(end), { key: "pi:message:id:m1", input: 2, output: 7, cacheRead: 11,
      cacheWrite: 4, total: 24, requests: 1, costUsd: 0.03, model: "llm" });
    assert.equal(parse(end), undefined);
  });

  it("accepts positive Pi estimates but only a provider-confirmed zero", () => {
    for (const [cost, expected] of [[undefined, null], [{ total: 5 }, 5], [{ total: 0 }, null],
      [{ total: 5, totalFromProvider: false }, 5], [{ total: 0, totalFromProvider: true }, 0],
      [{ total: Infinity, totalFromProvider: true }, null]] as const) {
      const message = { ...msg, usage: { input: 0, cost } };
      assert.equal(createUsageParser("pi")({ type: "message_end", message })?.costUsd, expected);
    }
  });

  it("does not claim a request for an aborted zero-usage message without a response id", () => {
    const parse = createUsageParser("pi");
    const message = { role: "assistant", stopReason: "aborted", timestamp: 123, usage: { totalTokens: 0 } };
    const end = { type: "message_end", message };
    assert.equal(parse(end)?.requests, null);
    assert.equal(parse(end), undefined);
    assert.ok(parse({ ...end, message: { ...message, timestamp: 124 } }));
  });
});
