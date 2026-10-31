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

    await facade.create({
      kind: "pi",
      title: "In workspace",
      prompt: "go",
      cwd: dir,
      workspaceId: "ws_app",
    });
    assert.equal(calls[2]?.workspaceId, "ws_app");
    assert.equal(
      await rejectCode(facade.create({
        kind: "pi",
        title: "Bad workspace",
        prompt: "go",
        cwd: dir,
        workspaceId: "not a workspace",
      })),
      "bad_request",
    );
    assert.equal(calls.length, 3);
  });

  it("creates and deletes workspaces with the board's safety rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-facade-ws-"));
    const saved: Array<{ id: string; name: string; path: string }> = [];
    const events: string[] = [];
    const facade = createBoardFacade({
      upsertWorkspace: async (ws) => {
        saved.push(ws);
        return ws;
      },
      publish: (ev) => {
        events.push(ev.type);
      },
      allocateWorkspaceId: () => "ws_test",
      now: () => "2026-10-31T00:00:00.000Z",
      removeWorkspace: async (id) => {
        if (id === "ws_default") throw new Error("cannot delete the default workspace");
        if (id === "ws_busy") throw new Error("workspace still has tasks; move or delete them first");
        if (id === "ws_gone") return false;
        return true;
      },
    });

    const created = await facade.createWorkspace({ name: "  App  ", path: dir });
    assert.equal(created.id, "ws_test");
    assert.equal(created.name, "App");
    assert.equal(created.path.startsWith("/"), true);
    assert.equal(events[0], "workspace_upsert");
    assert.equal(saved[0]?.name, "App");

    assert.equal(await rejectCode(facade.createWorkspace({ name: "   ", path: dir })), "bad_request");
    const missing = "/tmp/agent-board-missing-workspace-path";
    try {
      await facade.createWorkspace({ name: "Missing", path: missing });
      assert.fail("missing path should throw");
    } catch (err) {
      assert.ok(err instanceof RelayCommandError);
      assert.equal(err.code, "bad_request");
      assert.equal(err.message, "path not found");
      assert.equal(err.message.includes(missing), false);
    }
    assert.equal(
      await rejectCode(facade.createWorkspace({ name: "Rel", path: "relative/path" })),
      "bad_request",
    );
    assert.equal(await rejectMessage(facade.deleteWorkspace("ws_default")), "cannot delete the default workspace");
    assert.equal(
      await rejectMessage(facade.deleteWorkspace("ws_busy")),
      "workspace still has tasks; move or delete them first",
    );
    assert.equal(await rejectCode(facade.deleteWorkspace("ws_gone")), "not_found");
    assert.equal(events.includes("workspace_delete"), false);

    await facade.deleteWorkspace("ws_test");
    assert.equal(events.at(-1), "workspace_delete");
  });
});

async function rejectCode(p: Promise<unknown>): Promise<string> {
  const err = await rejected(p);
  return err.code;
}

async function rejectMessage(p: Promise<unknown>): Promise<string> {
  const err = await rejected(p);
  return err.message;
}

async function rejected(p: Promise<unknown>): Promise<RelayCommandError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof RelayCommandError);
    return err;
  }
  throw new Error("expected rejection");
}
