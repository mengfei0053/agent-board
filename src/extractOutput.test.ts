import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeStreamLogLine,
  extractFinalOutput,
  extractOutputsByIteration,
  extractPromptsByIteration,
  extractTextFromEventLine,
  linesForOutputMerge,
  formatErrorMessage,
  isBoardMetaLine,
  latestOutputText,
  mergeOutputTurns,
  mergePromptTurns,
  summarizeOutput,
  upsertOutputTurn,
  upsertPromptTurn,
} from "./extractOutput.js";

describe("extractTextFromEventLine", () => {
  it("ignores non-json / empty", () => {
    assert.equal(extractTextFromEventLine("hello"), undefined);
    assert.equal(extractTextFromEventLine(""), undefined);
  });

  it("reads pi message_update text_end", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "  pi reply  " },
    });
    assert.equal(extractTextFromEventLine(line), "pi reply");
  });

  it("reads pi message_end assistant content", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    assert.equal(extractTextFromEventLine(line), "done");
  });

  it("reads claude assistant + codex item.completed", () => {
    assert.equal(
      extractTextFromEventLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "output_text", text: "claude" }] },
        }),
      ),
      "claude",
    );
    assert.equal(
      extractTextFromEventLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "codex hi" },
        }),
      ),
      "codex hi",
    );
  });

  it("reads event_msg / result / generic assistant", () => {
    assert.equal(
      extractTextFromEventLine(
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "rollout" },
        }),
      ),
      "rollout",
    );
    assert.equal(
      extractTextFromEventLine(JSON.stringify({ type: "result", result: "ok" })),
      "ok",
    );
    assert.equal(
      extractTextFromEventLine(
        JSON.stringify({
          message: { role: "assistant", content: "generic" },
        }),
      ),
      "generic",
    );
  });

  it("reads a stored log_truncated wrapper", () => {
    assert.equal(
      extractTextFromEventLine(
        JSON.stringify({ type: "log_truncated", recoveredText: "kept reply" }),
      ),
      "kept reply",
    );
  });

  it("does not treat broken JSON as plain assistant text", () => {
    const turns = extractOutputsByIteration([
      '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"cut',
    ]);
    assert.deepEqual(turns, []);
  });

  it("recovers truncated pi text_end lines", () => {
    // JSON broken after content string, but content field itself is closed
    const broken =
      '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"partial reply","more":';
    assert.equal(extractTextFromEventLine(broken), "partial reply");
  });
});

describe("isBoardMetaLine / extractOutputsByIteration", () => {
  it("detects board meta types", () => {
    assert.equal(isBoardMetaLine(JSON.stringify({ type: "spawn" })), true);
    assert.equal(isBoardMetaLine(JSON.stringify({ type: "continue" })), true);
    assert.equal(isBoardMetaLine(JSON.stringify({ type: "assistant" })), false);
    assert.equal(isBoardMetaLine("not-json"), false);
  });

  it("takes last text per start/continue segment", () => {
    const lines = [
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "result", result: "round1-a" }),
      JSON.stringify({ type: "result", result: "round1-b" }),
      JSON.stringify({ type: "continue", iteration: 2 }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "round2" },
      }),
    ];
    const turns = extractOutputsByIteration(lines);
    assert.deepEqual(turns, [
      { iteration: 1, text: "round1-b" },
      { iteration: 2, text: "round2" },
    ]);
    assert.equal(extractFinalOutput(lines), "round2");
  });

  it("falls back to plain text when no json events", () => {
    const turns = extractOutputsByIteration(["hello plain", JSON.stringify({ type: "spawn" })]);
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /hello plain/);
  });

  it("uses fallbackIteration when no segments", () => {
    const lines = [JSON.stringify({ type: "result", result: "only" })];
    assert.deepEqual(extractOutputsByIteration(lines, 3), [
      { iteration: 3, text: "only" },
    ]);
  });

  it("merges stdout only and drops stderr result plus plain text", () => {
    const lines = [
      JSON.stringify({ type: "start" }),
      encodeStreamLogLine("stderr", JSON.stringify({ type: "result", result: "from-err" })),
      encodeStreamLogLine("stderr", "plain stderr noise"),
      encodeStreamLogLine("stdout", JSON.stringify({ type: "result", result: "from-out" })),
    ];
    assert.equal(linesForOutputMerge(lines).some((l) => l.includes("from-err")), false);
    assert.deepEqual(extractOutputsByIteration(lines), [{ iteration: 1, text: "from-out" }]);
    assert.equal(extractFinalOutput(lines), "from-out");
  });

  it("keeps stdout plain text and skips stderr plain text", () => {
    const lines = [
      encodeStreamLogLine("stderr", "noise from err"),
      encodeStreamLogLine("stdout", "hello from out"),
    ];
    const turns = extractOutputsByIteration(lines);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.text, "hello from out");
  });

  it("does not treat a preview-only truncation wrapper as the answer", () => {
    const stored = JSON.stringify({
      type: "log_truncated",
      originalChars: 20_000,
      preview: '{"type":"result","result":"short"}',
    });
    assert.equal(extractTextFromEventLine(stored), undefined);
    assert.deepEqual(extractOutputsByIteration([stored]), []);
  });
});

describe("merge / upsert / summarize / formatError", () => {
  it("upserts and merges output turns with remap", () => {
    const a = upsertOutputTurn([], { iteration: 1, text: "a" });
    const b = upsertOutputTurn(a, { iteration: 1, text: "a2" });
    assert.equal(b.length, 1);
    assert.equal(b[0].text, "a2");
    assert.equal(latestOutputText(b), "a2");
    assert.equal(latestOutputText(undefined), "");

    const merged = mergeOutputTurns(
      [{ iteration: 1, text: "old1" }],
      [{ iteration: 1, text: "new-unmarked" }],
      2,
    );
    assert.deepEqual(
      merged.map((t) => ({ iteration: t.iteration, text: t.text })),
      [
        { iteration: 1, text: "old1" },
        { iteration: 2, text: "new-unmarked" },
      ],
    );
  });

  it("does not replace a longer live turn with a shorter extracted result", () => {
    const long = "final ".repeat(2000);
    const merged = mergeOutputTurns(
      [{ iteration: 1, text: long, at: "2026-01-01T00:00:02.000Z" }],
      [{ iteration: 1, text: "short earlier result" }],
      1,
    );
    assert.equal(merged[0]?.text, long);
  });

  it("extracts and merges prompt turns", () => {
    const lines = [
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "continue", iteration: 2, prompt: " go on " }),
    ];
    const extracted = extractPromptsByIteration(lines, "first");
    assert.deepEqual(extracted, [
      { iteration: 1, prompt: "first" },
      { iteration: 2, prompt: "go on" },
    ]);
    const merged = mergePromptTurns(
      [{ iteration: 2, prompt: "stored-wins" }],
      extracted,
    );
    assert.equal(merged.find((p) => p.iteration === 2)?.prompt, "stored-wins");
    const up = upsertPromptTurn([], { iteration: 1, prompt: "p" });
    assert.equal(up[0].prompt, "p");
  });

  it("summarizes and formats errors", () => {
    assert.equal(summarizeOutput("short"), "short");
    assert.ok(summarizeOutput("x".repeat(200), 20).endsWith("…"));
    assert.match(
      formatErrorMessage({ error: "boom", exitCode: 1 }),
      /boom.*退出码 1/,
    );
    assert.equal(
      formatErrorMessage({ status: "failed" }),
      "任务失败（无详细错误信息）",
    );
    assert.equal(formatErrorMessage({ status: "stopped" }), "已由用户停止");
  });
});
