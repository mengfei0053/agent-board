import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LOG_TAIL_CHARS,
  DEFAULT_LOG_TAIL_LINES,
  MAX_LOG_LINE_CHARS,
  truncateLogLine,
  trimLogsKeepingMeta,
} from "./store.js";

describe("truncateLogLine (U12)", () => {
  it("passes through short lines", () => {
    assert.equal(truncateLogLine("hello"), "hello");
    assert.equal(truncateLogLine("x".repeat(MAX_LOG_LINE_CHARS)), "x".repeat(MAX_LOG_LINE_CHARS));
  });

  it("truncates long lines with omitted count", () => {
    const long = "a".repeat(MAX_LOG_LINE_CHARS + 123);
    const out = truncateLogLine(long);
    assert.ok(out.startsWith("a".repeat(MAX_LOG_LINE_CHARS)));
    assert.match(out, /…\[truncated 123 chars\]$/);
    assert.ok(out.length < long.length);
  });

  it("honors custom maxChars", () => {
    assert.equal(truncateLogLine("abcdef", 3), "abc…[truncated 3 chars]");
  });
});

describe("trimLogsKeepingMeta (U12)", () => {
  it("no-ops when under cap", () => {
    const arr = ["one", "two"];
    trimLogsKeepingMeta(arr, 10);
    assert.deepEqual(arr, ["one", "two"]);
  });

  it("keeps all board meta lines and trims rest to budget", () => {
    const metaStart = JSON.stringify({ type: "start", at: 1 });
    const metaExit = JSON.stringify({ type: "exit", code: 0 });
    const arr = [
      metaStart,
      "noise-1",
      "noise-2",
      "noise-3",
      "noise-4",
      metaExit,
      "noise-5",
    ];
    // maxLines=4 → keep 2 meta + last 2 non-meta among remaining budget
    trimLogsKeepingMeta(arr, 4);
    assert.ok(arr.includes(metaStart));
    assert.ok(arr.includes(metaExit));
    assert.equal(arr.length, 4);
    // meta first, then newest rest
    assert.equal(arr[0], metaStart);
    assert.equal(arr[1], metaExit);
    assert.deepEqual(arr.slice(2), ["noise-4", "noise-5"]);
  });

  it("ignores non-meta JSON and plain lines as rest", () => {
    const arr = [
      JSON.stringify({ type: "agent_end", x: 1 }),
      "plain",
      JSON.stringify({ type: "continue", n: 2 }),
    ];
    trimLogsKeepingMeta(arr, 2);
    assert.equal(arr.length, 2);
    assert.ok(arr.some((l) => l.includes('"continue"')));
  });
});

describe("log tail defaults (U12)", () => {
  it("exports sensible defaults", () => {
    assert.ok(DEFAULT_LOG_TAIL_LINES > 0);
    assert.ok(DEFAULT_LOG_TAIL_CHARS > DEFAULT_LOG_TAIL_LINES);
    assert.ok(MAX_LOG_LINE_CHARS >= 1000);
  });
});
