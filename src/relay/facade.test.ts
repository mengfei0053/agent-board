import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_PROMPT_CHARS, MAX_TITLE_CHARS } from "../limits.js";
import type { CreateTaskInput } from "../types.js";
import { RelayCommandError } from "./errors.js";
import { createBoardFacade } from "./facade.js";
import { makeTask } from "./harness.js";

describe("board facade create gates", () => {
  it("rejects invalid cwd and oversized text without calling createAndStart", async () => {
    const calls: CreateTaskInput[] = [];
    const facade = createBoardFacade({
      createAndStart: async (input) => {
        calls.push(input);
        return makeTask();
      },
    });
    const base = { kind: "pi" as const, title: "Title", prompt: "Prompt" };

    const relative = await rejectCode(facade.create({ ...base, cwd: "relative/path" }));
    assert.equal(relative, "bad_request");

    const missing = "/tmp/agent-board-missing-cwd-not-real";
    try {
      await facade.create({ ...base, cwd: missing });
      assert.fail("missing cwd should throw");
    } catch (err) {
      assert.ok(err instanceof RelayCommandError);
      assert.equal(err.code, "bad_request");
      assert.equal(err.message.includes(missing), false);
    }

    const filePath = join(mkdtempSync(join(tmpdir(), "ab-facade-")), "file.txt");
    writeFileSync(filePath, "x");
    assert.equal(await rejectCode(facade.create({ ...base, cwd: filePath })), "bad_request");

    assert.equal(
      await rejectCode(facade.create({ ...base, cwd: "/etc" })),
      "bad_request",
    );
    assert.equal(
      await rejectCode(facade.create({
        ...base,
        cwd: tmpdir(),
        title: "t".repeat(MAX_TITLE_CHARS + 1),
      })),
      "bad_request",
    );
    assert.equal(
      await rejectCode(facade.create({
        ...base,
        cwd: tmpdir(),
        prompt: "p".repeat(MAX_PROMPT_CHARS + 1),
      })),
      "bad_request",
    );
    assert.equal(
      await rejectCode(facade.create({
        ...base,
        cwd: tmpdir(),
        useGitWorktree: "yes" as unknown as boolean,
      })),
      "bad_request",
    );
    assert.equal(calls.length, 0);
  });

  it("forwards useGitWorktree true and a resolved cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-facade-ok-"));
    const calls: CreateTaskInput[] = [];
    const facade = createBoardFacade({
      createAndStart: async (input) => {
        calls.push(input);
        return makeTask({ cwd: input.cwd, title: input.title });
      },
    });
    await facade.create({
      kind: "codex",
      title: "Ship",
      prompt: "go",
      cwd: dir,
      useGitWorktree: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.useGitWorktree, true);
    assert.equal(calls[0]?.kind, "codex");
    assert.ok(calls[0]?.cwd?.startsWith("/"));

    await facade.create({
      kind: "pi",
      title: "Plain",
      prompt: "go",
      cwd: dir,
      useGitWorktree: false,
    });
    assert.equal("useGitWorktree" in (calls[1] ?? {}), false);
  });
});

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof RelayCommandError);
    return err.code;
  }
  throw new Error("expected rejection");
}
