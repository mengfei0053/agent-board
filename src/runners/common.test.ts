import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RATE_LIMIT_STRIKE_LIMIT,
  is429StrikeLine,
  isExceededRetryLimit429,
  isProgressLine,
  lineLooksLike429,
} from "./common.js";
import { createStreamLineState, endStream, pushStreamBytes } from "../streamLines.js";

describe("stream line buffer", () => {
  it("decodes a utf-8 character split across chunks and keeps streams separate", () => {
    const state = createStreamLineState();
    const you = Buffer.from("你", "utf8");
    const first = pushStreamBytes(state, you.subarray(0, 2));
    assert.deepEqual(first.lines, []);
    const second = pushStreamBytes(state, Buffer.concat([you.subarray(2), Buffer.from("\n")]));
    assert.deepEqual(second.lines, ["你"]);
    pushStreamBytes(state, Buffer.from("tail"));
    assert.equal(endStream(state), "tail");
  });

  it("drops an unterminated line that exceeds the cap", () => {
    const state = createStreamLineState();
    const huge = Buffer.alloc(1_000_001, 0x61);
    const pushed = pushStreamBytes(state, huge);
    assert.equal(pushed.truncated, true);
    assert.deepEqual(pushed.lines, []);
    assert.equal(state.buf, "");
  });
});

describe("429 detection", () => {
  it("lineLooksLike429 matches 429 and too many requests", () => {
    assert.equal(lineLooksLike429("HTTP 429"), true);
    assert.equal(lineLooksLike429("Too Many Requests"), true);
    assert.equal(lineLooksLike429("ok 200"), false);
    assert.equal(RATE_LIMIT_STRIKE_LIMIT, 5);
  });

  it("isExceededRetryLimit429 needs both phrases", () => {
    assert.equal(
      isExceededRetryLimit429("exceeded retry limit after status 429"),
      true,
    );
    assert.equal(isExceededRetryLimit429("exceeded retry limit"), false);
    assert.equal(isExceededRetryLimit429("status 429 only"), false);
  });

  it("is429StrikeLine on error json / reconnect / status", () => {
    assert.equal(
      is429StrikeLine(JSON.stringify({ type: "error", message: "429" })),
      true,
    );
    assert.equal(
      is429StrikeLine(JSON.stringify({ type: "rate_limit", status: 429 })),
      true,
    );
    assert.equal(
      is429StrikeLine(
        JSON.stringify({ type: "error", error: { message: "HTTP 429" } }),
      ),
      true,
    );
    assert.equal(is429StrikeLine("reconnecting… status: 429"), true);
    assert.equal(
      is429StrikeLine(JSON.stringify({ type: "assistant", text: "hi 429?" })),
      false,
    );
    // plain text with 429 but not error-shaped — still true via reconnect/status patterns or false
    assert.equal(is429StrikeLine("note: code 429 in docs"), false);
  });

  it("isProgressLine resets on non-error events and rejects 429", () => {
    assert.equal(
      isProgressLine(JSON.stringify({ type: "assistant" })),
      true,
    );
    assert.equal(
      isProgressLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })),
      true,
    );
    assert.equal(
      isProgressLine(JSON.stringify({ type: "error", message: "429" })),
      false,
    );
    assert.equal(isProgressLine("not json"), false);
    assert.equal(isProgressLine(JSON.stringify({ type: "turn.failed" })), false);
  });
});
