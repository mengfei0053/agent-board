import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { GitWorkspaceStatus } from "../gitStatus.js";
import { createDraft } from "../manager.js";
import { childProcessEnv, _resetProxyEnvOverridesForTests } from "../proxyEnv.js";
import { setSettingsMetaUpsertForTests } from "../settingsDocument.js";
import {
  disableMemoryStoreForTests,
  enableMemoryStoreForTests,
  getTask,
  getWorkspace,
  upsertTask,
} from "../store.js";
import { RelayCommandError } from "./errors.js";
import { createBoardFacade } from "./facade.js";

const SECRET = "s3cret-pass";

describe("facade settings and workspace cards", () => {
  let workspaceId = "";

  beforeEach(() => {
    workspaceId = enableMemoryStoreForTests();
    setSettingsMetaUpsertForTests(async () => undefined);
    _resetProxyEnvOverridesForTests({});
  });

  afterEach(() => {
    setSettingsMetaUpsertForTests(null);
    _resetProxyEnvOverridesForTests({});
    disableMemoryStoreForTests();
  });

  it("round-trips workspace settings without rewriting task cwd", async () => {
    const next = mkdtempSync(join(tmpdir(), "ab-ws-next-"));
    const draft = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "stay",
      title: "stay",
    });
    const cwd = getTask(draft.id)?.cwd;
    assert.ok(cwd);
    const facade = createBoardFacade({
      gitEligibility: async () => ({ ok: true }),
      workspaceGitStatus: async () => gitOk(),
    });
    const saved = await facade.updateWorkspace({
      workspaceId,
      name: "Renamed",
      path: next,
      settings: { systemPrompt: "be brief", skills: ["one"], mcp: "" },
    });
    assert.equal(saved.name, "Renamed");
    assert.equal(saved.settings.systemPrompt, "be brief");
    assert.deepEqual(saved.settings.skills, ["one"]);
    assert.equal(saved.settings.mcp, "");
    assert.equal(saved.isGit, true);
    assert.equal(saved.git.branch, "main");
    assert.equal(saved.git.dirty, true);
    assert.equal(saved.git.error, null);
    assert.equal(getTask(draft.id)?.cwd, cwd);
    assert.notEqual(getWorkspace(workspaceId)?.path, cwd);
    assert.equal(getWorkspace(workspaceId)?.settings?.mcp, undefined);

    const failedGit = createBoardFacade({
      gitEligibility: async () => {
        throw new Error("probe failed");
      },
      workspaceGitStatus: async () => {
        throw new Error("fatal: /secret/repo");
      },
    });
    const card = await failedGit.getWorkspace(workspaceId);
    assert.equal(card.path, saved.path);
    assert.equal(card.settings.systemPrompt, "be brief");
    assert.equal(card.isGit, false);
    assert.equal(card.git.error, "git status failed");
    assert.equal(JSON.stringify(card).includes("/secret/repo"), false);
  });

  it("rejects a non-terminal archive and an archived continue", async () => {
    const draft = await createDraft({ kind: "pi", workspaceId, prompt: "p", title: "t" });
    const facade = createBoardFacade();
    const running = getTask(draft.id);
    if (!running) throw new Error("missing");
    upsertTask({ ...running, status: "running" });
    const rejected = await reject(facade.archive(draft.id));
    assert.equal(rejected.code, "bad_request");
    assert.equal(rejected.message, "task is still running");
    assert.equal(getTask(draft.id)?.status, "running");

    upsertTask({ ...getTask(draft.id)!, status: "stopped" });
    const archived = await facade.archive(draft.id);
    assert.deepEqual(archived, { taskId: draft.id });
    assert.equal(getTask(draft.id)?.status, "archived");
    const again = await reject(facade.archive(draft.id));
    assert.equal(again.code, "archived_readonly");
    const continued = await reject(facade.continue(draft.id, "more"));
    assert.equal(continued.code, "archived_readonly");
    const stopped = await reject(facade.stop(draft.id));
    assert.equal(stopped.code, "archived_readonly");
    assert.equal(getTask(draft.id)?.status, "archived");
  });

  it("returns the redacted settings document and refuses clear", async () => {
    const facade = createBoardFacade();
    const proxy = `http://user:${SECRET}@127.0.0.1:8899`;
    const saved = await facade.putSettings({
      proxyEnv: { codex: { HTTP_PROXY: proxy } },
    });
    assert.equal(saved.proxyEnv.codex.HTTP_PROXY.override, "http://user:***@127.0.0.1:8899");
    assert.equal(JSON.stringify(saved).includes(SECRET), false);
    assert.equal(childProcessEnv("codex").HTTP_PROXY, proxy);
    const again = await facade.putSettings({
      proxyEnv: { codex: { HTTP_PROXY: saved.proxyEnv.codex.HTTP_PROXY.override } },
    });
    assert.equal(childProcessEnv("codex").HTTP_PROXY, proxy);
    assert.equal(JSON.stringify(again).includes(SECRET), false);
    const refused = await reject(facade.putSettings({ clear: true }));
    assert.equal(refused.code, "bad_request");
    assert.equal(refused.message, "clear is not allowed");
    assert.equal(JSON.stringify(refused).includes(SECRET), false);
    assert.equal(childProcessEnv("codex").HTTP_PROXY, proxy);
  });
});

function gitOk(): GitWorkspaceStatus {
  return {
    root: "/tmp",
    repos: [{
      path: "/tmp",
      relPath: ".",
      branch: "main",
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      dirty: true,
      head: "abc",
      subject: null,
      noCommits: false,
      files: [{ code: "??", x: "?", y: "?", path: "secret.txt", label: "untracked" }],
      fileCount: 1,
      filesTruncated: false,
      error: null,
    }],
    truncated: false,
    scannedDirs: 1,
    caps: { maxDepth: 1, maxRepos: 1, maxDirs: 1, maxFilesPerRepo: 1 },
    cached: false,
  };
}

async function reject(promise: Promise<unknown>): Promise<RelayCommandError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof RelayCommandError);
    return err;
  }
  throw new Error("expected a relay error");
}
