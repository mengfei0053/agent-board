import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiArgs } from "./pi.js";
import { buildClaudeArgs } from "./claude.js";
import { approvalFlags, baseExecFlags, buildCodexArgs, resumeFlags } from "./codex.js";
import { buildCursorArgs } from "./cursor.js";
import { buildDevinArgs } from "./devin.js";
import { runners } from "./index.js";

describe("U16 runner buildArgs (no spawn)", () => {
  describe("pi", () => {
    it("uses task.id as session when missing; includes model", () => {
      const r = buildPiArgs(
        { id: "t1", prompt: "hello", model: "gpt-x" },
      );
      assert.deepEqual(r.args, [
        "-p",
        "--mode",
        "json",
        "--session-id",
        "t1",
        "--model",
        "gpt-x",
        "hello",
      ]);
      assert.equal(r.assignSession, true);
      assert.equal(r.sessionId, "t1");
    });

    it("continuePrompt replaces prompt; keeps existing session", () => {
      const r = buildPiArgs(
        { id: "t1", prompt: "orig", sessionId: "sess-pi" },
        { continuePrompt: "  more  " },
      );
      assert.equal(r.prompt, "more");
      assert.ok(r.args.includes("sess-pi"));
      assert.equal(r.args.at(-1), "more");
      assert.equal(r.assignSession, false);
    });
  });

  describe("claude", () => {
    const fixedId = () => "fixed-uuid-0000";

    it("fresh start assigns --session-id", () => {
      const r = buildClaudeArgs({ prompt: "p" }, undefined, fixedId);
      assert.ok(r.args.includes("--session-id"));
      assert.ok(r.args.includes("fixed-uuid-0000"));
      assert.equal(r.assignedSession, true);
      assert.equal(r.continueNewSession, false);
      assert.equal(r.args.at(-1), "p");
    });

    it("continue with session uses --resume and continue prompt", () => {
      const r = buildClaudeArgs(
        { prompt: "orig", sessionId: "sid-1", model: "sonnet" },
        { continuePrompt: "next" },
        fixedId,
      );
      assert.deepEqual(
        r.args.slice(0, 6),
        ["-p", "--output-format", "stream-json", "--verbose", "--resume", "sid-1"],
      );
      assert.ok(r.args.includes("--model"));
      assert.ok(r.args.includes("sonnet"));
      assert.equal(r.args.at(-1), "next");
      assert.equal(r.assignedSession, false);
    });

    it("continue without session starts fresh with task.prompt", () => {
      const r = buildClaudeArgs(
        { prompt: "orig" },
        { continuePrompt: "ignored" },
        fixedId,
      );
      assert.equal(r.continueNewSession, true);
      assert.equal(r.assignedSession, true);
      assert.equal(r.args.at(-1), "orig");
      assert.ok(r.args.includes("--session-id"));
      assert.ok(!r.args.includes("--resume"));
    });
  });

  describe("codex", () => {
    it("approvalFlags / baseExecFlags / resumeFlags", () => {
      assert.deepEqual(approvalFlags(true), ["--approve-for-me"]);
      assert.deepEqual(approvalFlags(false), ["-s", "danger-full-access"]);
      const baseOn = baseExecFlags("gpt-5", true);
      assert.ok(baseOn.includes("--approve-for-me"));
      assert.ok(baseOn.includes("-m"));
      assert.ok(baseOn.includes("gpt-5"));
      const resume = resumeFlags("m1");
      assert.ok(!resume.includes("--approve-for-me"));
      assert.ok(!resume.includes("-s"));
      assert.ok(resume.includes("-m"));
    });

    it("fresh exec with sandbox on", () => {
      const r = buildCodexArgs({ prompt: "do it", model: "m" }, undefined, true);
      assert.equal(r.args[0], "exec");
      assert.ok(r.args.includes("--approve-for-me"));
      assert.equal(r.args.at(-1), "do it");
      assert.equal(r.continueNewSession, false);
    });

    it("resume places approval flags before resume", () => {
      const r = buildCodexArgs(
        { prompt: "orig", sessionId: "thr_1" },
        { continuePrompt: "again" },
        false,
      );
      const idxExec = r.args.indexOf("exec");
      const idxS = r.args.indexOf("-s");
      const idxResume = r.args.indexOf("resume");
      assert.ok(idxExec === 0);
      assert.ok(idxS > idxExec && idxS < idxResume);
      assert.equal(r.args[idxResume + 1], "thr_1");
      assert.equal(r.args.at(-1), "again");
    });

    it("continue without session uses task.prompt (not resume --last)", () => {
      const r = buildCodexArgs(
        { prompt: "orig" },
        { continuePrompt: "nope" },
        true,
      );
      assert.equal(r.continueNewSession, true);
      assert.ok(!r.args.includes("resume"));
      assert.equal(r.args.at(-1), "orig");
    });
  });

  describe("cursor", () => {
    it("fresh with resolved chat id resumes", () => {
      const r = buildCursorArgs(
        { prompt: "hi", model: "composer" },
        undefined,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      );
      assert.ok(r.args.includes("--trust"));
      assert.ok(r.args.includes("--resume"));
      assert.ok(r.args.includes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
      assert.ok(r.args.includes("--model"));
      assert.equal(r.args.at(-1), "hi");
      assert.equal(r.continueNewSession, false);
    });

    it("continue with prior session uses continue prompt", () => {
      const r = buildCursorArgs(
        { prompt: "orig", sessionId: "chat-old" },
        { continuePrompt: "follow" },
      );
      assert.equal(r.args.at(-1), "follow");
      assert.ok(r.args.includes("chat-old"));
      assert.equal(r.continueNewSession, false);
    });

    it("continue without prior session keeps task.prompt even if resolved", () => {
      const r = buildCursorArgs(
        { prompt: "orig" },
        { continuePrompt: "ignored" },
        "new-chat-id-0123456789abcdef",
      );
      assert.equal(r.continueNewSession, true);
      assert.equal(r.args.at(-1), "orig");
      assert.ok(r.args.includes("--resume"));
      assert.ok(r.args.includes("new-chat-id-0123456789abcdef"));
    });
  });

  describe("devin", () => {
    it("fresh run with model", () => {
      const r = buildDevinArgs({ prompt: "build", model: "d1" });
      assert.deepEqual(r.args.slice(0, 5), [
        "-p",
        "--permission-mode",
        "accept-edits",
        "--respect-workspace-trust",
        "false",
      ]);
      assert.ok(r.args.includes("--model"));
      assert.ok(r.args.includes("d1"));
      assert.equal(r.args.at(-2), "--");
      assert.equal(r.args.at(-1), "build");
    });

    it("continue with session uses -r", () => {
      const r = buildDevinArgs(
        { prompt: "orig", sessionId: "dv_1" },
        { continuePrompt: "more" },
      );
      assert.ok(r.args.includes("-r"));
      assert.ok(r.args.includes("dv_1"));
      assert.equal(r.args.at(-1), "more");
      assert.equal(r.continueNewSession, false);
    });

    it("continue without session uses task.prompt (not -c)", () => {
      const r = buildDevinArgs(
        { prompt: "orig" },
        { continuePrompt: "ignored" },
      );
      assert.equal(r.continueNewSession, true);
      assert.ok(!r.args.includes("-r"));
      assert.ok(!r.args.includes("-c"));
      assert.equal(r.args.at(-1), "orig");
    });
  });

  describe("runners index", () => {
    it("maps all agent kinds", () => {
      assert.deepEqual(Object.keys(runners).sort(), [
        "claude",
        "codex",
        "cursor",
        "devin",
        "pi",
      ]);
      for (const k of Object.keys(runners)) {
        assert.equal(typeof runners[k as keyof typeof runners].start, "function");
      }
    });
  });
});
