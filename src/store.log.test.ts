import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundStoredLogLine,
  DEFAULT_LOG_TAIL_CHARS,
  DEFAULT_LOG_TAIL_LINES,
  keptLogIndices,
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
    // Original order: start, noise-4, exit, noise-5 (not meta-first).
    assert.deepEqual(arr, [metaStart, "noise-4", metaExit, "noise-5"]);
  });

  it("keeps zero ordinary lines when the budget is only meta", () => {
    const meta = JSON.stringify({ type: "start" });
    const arr = [meta, "a", "b", "c"];
    trimLogsKeepingMeta(arr, 1);
    assert.deepEqual(arr, [meta]);
  });

  it("keeps nothing when the line budget is zero", () => {
    const arr = ["a", "b", JSON.stringify({ type: "exit", code: 0 })];
    trimLogsKeepingMeta(arr, 0);
    assert.deepEqual(arr, []);
  });

  it("caps meta lines and keeps the newest ones in order", () => {
    const metas = [1, 2, 3, 4, 5].map((n) => JSON.stringify({ type: "start", n }));
    const arr = [...metas, "noise"];
    trimLogsKeepingMeta(arr, 2);
    assert.deepEqual(arr, [metas[3], metas[4]]);
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

describe("boundStoredLogLine", () => {
  it("wraps a cut JSON line instead of leaving broken JSON", () => {
    const raw = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "hello reply" },
      pad: "x".repeat(9000),
    });
    const stored = boundStoredLogLine(raw, 200);
    const parsed = JSON.parse(stored) as { type?: string; recoveredText?: string };
    assert.equal(parsed.type, "log_truncated");
    assert.equal(parsed.recoveredText, "hello reply");
    assert.equal(typeof stored, "string");
    assert.ok(!stored.includes("…[truncated"));
  });

  it("keeps a long result string inside the truncated wrapper", () => {
    const result = "R".repeat(12_000);
    const raw = JSON.stringify({ type: "result", result });
    const stored = boundStoredLogLine(raw, 200);
    const parsed = JSON.parse(stored) as { type?: string; recoveredText?: string };
    assert.equal(parsed.type, "log_truncated");
    assert.equal(parsed.recoveredText, result);
  });

  it("selects indices in original order", () => {
    const start = JSON.stringify({ type: "start" });
    const cont = JSON.stringify({ type: "continue", iteration: 2 });
    const exit = JSON.stringify({ type: "exit", code: 0 });
    const lines = [start, "A", cont, "B", exit, "tail"];
    const idx = keptLogIndices(lines, 4);
    assert.deepEqual(idx.map((i) => lines[i]), [start, cont, exit, "tail"]);
  });
});

describe("log tail defaults (U12)", () => {
  it("exports sensible defaults", () => {
    assert.ok(DEFAULT_LOG_TAIL_LINES > 0);
    assert.ok(DEFAULT_LOG_TAIL_CHARS > DEFAULT_LOG_TAIL_LINES);
    assert.ok(MAX_LOG_LINE_CHARS >= 1000);
  });
});
