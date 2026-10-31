import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resumeCommand, shellQuote } from "./resumeCommand.js";

const SID = "sess-123";

describe("relay resume command", () => {
  it("matches the web board command for each agent", () => {
    assert.equal(resumeCommand({ kind: "pi", sessionId: SID }), `pi --session-id ${SID}`);
    assert.equal(resumeCommand({ kind: "claude", sessionId: SID }), `claude --resume ${SID}`);
    assert.equal(resumeCommand({ kind: "cursor", sessionId: SID }), `agent --resume ${SID}`);
    assert.equal(resumeCommand({ kind: "codex", sessionId: SID }), `codex exec resume ${SID}`);
    assert.equal(resumeCommand({ kind: "devin", sessionId: SID }), `devin -r ${SID}`);
    assert.equal(
      resumeCommand({ kind: "pi", sessionId: SID, cwd: "/tmp/agent-board" }),
      `cd /tmp/agent-board && pi --session-id ${SID}`,
    );
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(resumeCommand({ kind: "pi", sessionId: "" }), null);
    assert.equal(resumeCommand({ kind: "nope", sessionId: SID }), null);
  });
});
