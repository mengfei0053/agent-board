import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cliKeyForKind,
  NO_SESSION_LABEL,
  resumeCommand,
  resumeCommandView,
  resolveResumeBin,
  shellQuote,
} from "../../web/resumeCommand.js";

const SID = "sess-123";

describe("resumeCommand", () => {
  it("builds a resume command for each agent kind", () => {
    assert.equal(resumeCommand({ kind: "pi", sessionId: SID }), `pi --session-id ${SID}`);
    assert.equal(resumeCommand({ kind: "claude", sessionId: SID }), `claude --resume ${SID}`);
    assert.equal(resumeCommand({ kind: "cursor", sessionId: SID }), `agent --resume ${SID}`);
    assert.equal(resumeCommand({ kind: "codex", sessionId: SID }), `codex exec resume ${SID}`);
    assert.equal(resumeCommand({ kind: "devin", sessionId: SID }), `devin -r ${SID}`);
  });

  it("uses the real resume flags, not board-only or invented ones", () => {
    const pi = resumeCommand({ kind: "pi", sessionId: SID });
    assert.match(pi, /--session-id/);
    assert.doesNotMatch(pi, /--session(?:\s|$)/);
    assert.doesNotMatch(pi, /-p|--mode/);

    const claude = resumeCommand({ kind: "claude", sessionId: SID });
    assert.match(claude, /--resume/);
    assert.doesNotMatch(claude, /stream-json|--verbose|-p/);

    const cursor = resumeCommand({ kind: "cursor", sessionId: SID });
    assert.match(cursor, /^agent --resume /);
    assert.doesNotMatch(cursor, /cursor --resume|stream-json|--trust|-p/);

    const codex = resumeCommand({ kind: "codex", sessionId: SID });
    assert.equal(codex, `codex exec resume ${SID}`);
    assert.doesNotMatch(codex, /--json|--approve-for-me|danger-full-access|-m /);

    const devin = resumeCommand({ kind: "devin", sessionId: SID });
    assert.match(devin, /-r /);
    assert.doesNotMatch(devin, /(^|\s)-c(\s|$)|--permission-mode|-p/);
  });

  it("returns null when sessionId is missing", () => {
    for (const kind of ["pi", "claude", "cursor", "devin", "codex"]) {
      assert.equal(resumeCommand({ kind, sessionId: undefined, cwd: "/tmp/proj" }), null);
      assert.equal(resumeCommand({ kind, sessionId: "" }), null);
      assert.equal(resumeCommand({ kind, sessionId: "   " }), null);
      assert.equal(resumeCommand({ kind }), null);
      assert.deepEqual(resumeCommandView({ kind, cwd: "/tmp/proj" }), {
        command: null,
        emptyLabel: NO_SESSION_LABEL,
      });
    }
    assert.equal(resumeCommand({}), null);
    assert.equal(resumeCommand({ kind: "nope", sessionId: SID }), null);
    assert.deepEqual(resumeCommandView({ kind: "nope", sessionId: SID }), {
      command: null,
      emptyLabel: "—",
    });
    assert.equal(NO_SESSION_LABEL, "尚无会话");
  });

  it("prefixes cd when cwd is set and quotes unsafe tokens", () => {
    assert.equal(
      resumeCommand({ kind: "pi", sessionId: SID, cwd: "/tmp/agent-board" }),
      `cd /tmp/agent-board && pi --session-id ${SID}`,
    );
    assert.equal(
      resumeCommand({ kind: "claude", sessionId: "id with space", cwd: "/work/my proj" }),
      `cd '/work/my proj' && claude --resume 'id with space'`,
    );
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(
      resumeCommand({ kind: "codex", sessionId: "thr_1", cwd: "/tmp/it's" }),
      `cd '/tmp/it'\\''s' && codex exec resume thr_1`,
    );
  });

  it("uses a configured binary, with cursor mapped to the agent cli key", () => {
    assert.equal(cliKeyForKind("cursor"), "agent");
    assert.equal(cliKeyForKind("pi"), "pi");
    assert.equal(
      resumeCommand({
        kind: "cursor",
        sessionId: SID,
        bin: "/opt/bin/agent",
      }),
      `/opt/bin/agent --resume ${SID}`,
    );
    assert.equal(
      resumeCommand({
        kind: "pi",
        sessionId: SID,
        bin: { effective: "/tmp/e2e-fake-pi", override: "/ignored", default: "pi" },
      }),
      `/tmp/e2e-fake-pi --session-id ${SID}`,
    );
    assert.equal(
      resolveResumeBin("devin", { override: "/opt/devin", default: "devin" }),
      "/opt/devin",
    );
    assert.equal(resolveResumeBin("claude", { default: "claude" }), "claude");
    assert.equal(resolveResumeBin("codex", undefined), "codex");
    assert.equal(
      resumeCommand({
        kind: "devin",
        sessionId: SID,
        bin: { override: "", default: "" },
      }),
      `devin -r ${SID}`,
    );
  });
});
