import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { discoverGitRepos } from "./gitStatus.js";
import { gitReadOnlyEnv } from "./gitStatus.js";
import {
  WORKTREE_BRANCH_EXISTS,
  WORKTREE_DEST_EXISTS,
  WORKTREE_NOT_ROOT,
  WORKTREE_UNBORN,
  WORKTREE_UNSAFE_PATH,
  expectedWorktreePath,
  getGitWorktreeEligibility,
  worktreeBranchName,
} from "./gitWorktree.js";
import { createDraft, removeTasks, setNextTaskIdForTests } from "./manager.js";
import {
  disableMemoryStoreForTests,
  enableMemoryStoreForTests,
  failNextPersistForTests,
  getDefaultWorkspaceId,
  getTask,
  setPersistDryRunForTests,
  upsertTask,
  upsertWorkspace,
} from "./store.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-wt-")));
  scratchDirs.push(dir);
  return dir;
}

function gitEnv(): NodeJS.ProcessEnv {
  return gitReadOnlyEnv({
    ...process.env,
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "tester@example.com",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "tester@example.com",
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: "pipe" }).toString("utf8");
}

function gitFails(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return false;
  } catch {
    return true;
  }
}

function initRepo(dir: string, commit = true): void {
  git(dir, ["init", "-b", "main"]);
  if (!commit) return;
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "init"]);
}

let nextWs = 0;

async function useWorkspace(path: string): Promise<string> {
  const now = new Date().toISOString();
  const id = `ws-wt-${++nextWs}`;
  await upsertWorkspace({
    id,
    name: "git",
    path,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("git worktree unit", { concurrency: 1 }, () => {
describe("getGitWorktreeEligibility", { concurrency: 1 }, () => {
  it("accepts a work tree root with HEAD and rejects nested, unborn, and non-repos", async () => {
    const root = scratch();
    initRepo(root);
    const ok = await getGitWorktreeEligibility(root);
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.root, root);
    assert.equal(ok.head, git(root, ["rev-parse", "HEAD"]).trim());

    const nestedOnly = scratch();
    const child = join(nestedOnly, "pkg");
    mkdirSync(child);
    initRepo(child);
    const parent = await getGitWorktreeEligibility(nestedOnly);
    assert.deepEqual(parent, { ok: false, reason: WORKTREE_NOT_ROOT });
    const childOk = await getGitWorktreeEligibility(child);
    assert.equal(childOk.ok, true);

    mkdirSync(join(root, "sub"));
    const sub = await getGitWorktreeEligibility(join(root, "sub"));
    assert.deepEqual(sub, { ok: false, reason: WORKTREE_NOT_ROOT });

    const unborn = scratch();
    initRepo(unborn, false);
    const noHead = await getGitWorktreeEligibility(unborn);
    assert.deepEqual(noHead, { ok: false, reason: WORKTREE_UNBORN });

    const plain = scratch();
    writeFileSync(join(plain, "note.txt"), "x\n");
    const notGit = await getGitWorktreeEligibility(plain);
    assert.deepEqual(notGit, { ok: false, reason: WORKTREE_NOT_ROOT });
  });

  it("matches a symlinked path to the canonical root and ignores GIT_DIR", async () => {
    const root = scratch();
    initRepo(root);
    const linkParent = scratch();
    const link = join(linkParent, "repo");
    symlinkSync(root, link);
    const viaLink = await getGitWorktreeEligibility(link);
    assert.equal(viaLink.ok, true);
    if (viaLink.ok) assert.equal(viaLink.root, root);

    const decoy = scratch();
    initRepo(decoy);
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy, ".git");
    try {
      const still = await getGitWorktreeEligibility(root);
      assert.equal(still.ok, true);
      if (still.ok) assert.equal(still.head, git(root, ["rev-parse", "HEAD"]).trim());
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});

describe("createDraft worktree", { concurrency: 1 }, () => {
  beforeEach(() => {
    enableMemoryStoreForTests();
    setNextTaskIdForTests(null);
    setPersistDryRunForTests(false);
  });

  afterEach(() => {
    setNextTaskIdForTests(null);
    setPersistDryRunForTests(false);
    disableMemoryStoreForTests();
  });

  it("leaves the cwd unchanged when the flag is off", async () => {
    const root = scratch();
    initRepo(root);
    const workspaceId = await useWorkspace(root);
    const task = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "plain",
      title: "plain",
      useGitWorktree: false,
    });
    assert.equal(task.cwd, root);
    assert.equal(task.worktree, undefined);
    assert.equal(gitFails(root, ["rev-parse", "--verify", "refs/heads/agent-board/" + task.id]), true);
  });

  it("creates a branch and cwd under .agent-board and keeps the workspace id", async () => {
    const root = scratch();
    initRepo(root);
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const workspaceId = await useWorkspace(root);
    const task = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "in a worktree",
      title: "wt",
      useGitWorktree: true,
    });
    const expected = expectedWorktreePath(root, task.id);
    assert.equal(task.cwd, expected);
    assert.equal(task.workspaceId, workspaceId);
    assert.deepEqual(task.worktree, {
      path: expected,
      branch: worktreeBranchName(task.id),
      baseHead: head,
      owned: true,
    });
    assert.equal(git(expected, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), task.worktree?.branch);
    assert.equal(git(expected, ["rev-parse", "HEAD"]).trim(), head);
    const found = await discoverGitRepos(root);
    assert.equal(found.repos.some((repo) => repo.includes(".agent-board")), false);
    assert.equal(found.repos.length, 1);
  });

  it("rejects non-git, unborn, existing path, existing branch, and symlink dest with no task left", async () => {
    const plain = scratch();
    writeFileSync(join(plain, "note.txt"), "x\n");
    const plainId = await useWorkspace(plain);
    await assert.rejects(
      () => createDraft({ kind: "pi", workspaceId: plainId, prompt: "x", useGitWorktree: true }),
      (err: unknown) => {
        assert.equal((err as { statusCode?: number }).statusCode, 400);
        assert.match((err as Error).message, new RegExp(WORKTREE_NOT_ROOT));
        return true;
      },
    );
    assert.equal(existsSync(join(plain, ".agent-board")), false);

    const unborn = scratch();
    initRepo(unborn, false);
    const unbornId = await useWorkspace(unborn);
    setNextTaskIdForTests("unborn01");
    await assert.rejects(
      () => createDraft({ kind: "pi", workspaceId: unbornId, prompt: "x", useGitWorktree: true }),
      (err: unknown) => {
        assert.equal((err as { statusCode?: number }).statusCode, 400);
        assert.match((err as Error).message, new RegExp(WORKTREE_UNBORN));
        return true;
      },
    );
    assert.equal(existsSync(join(unborn, ".agent-board")), false);

    const root = scratch();
    initRepo(root);
    const workspaceId = await useWorkspace(root);
    const dest = expectedWorktreePath(root, "exists01");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "keep.txt"), "keep\n");
    setNextTaskIdForTests("exists01");
    await assert.rejects(
      () => createDraft({ kind: "pi", workspaceId, prompt: "x", useGitWorktree: true }),
      (err: unknown) => {
        assert.equal((err as { statusCode?: number }).statusCode, 400);
        assert.match((err as Error).message, new RegExp(WORKTREE_DEST_EXISTS));
        return true;
      },
    );
    assert.equal(readFileSync(join(dest, "keep.txt"), "utf8"), "keep\n");

    git(root, ["branch", worktreeBranchName("branch01")]);
    setNextTaskIdForTests("branch01");
    await assert.rejects(
      () => createDraft({ kind: "pi", workspaceId, prompt: "x", useGitWorktree: true }),
      (err: unknown) => {
        assert.equal((err as { statusCode?: number }).statusCode, 400);
        assert.match((err as Error).message, new RegExp(WORKTREE_BRANCH_EXISTS));
        return true;
      },
    );
    assert.equal(gitFails(root, ["show-ref", "--verify", "--quiet", "refs/heads/agent-board/branch01"]), false);
    assert.equal(existsSync(expectedWorktreePath(root, "branch01")), false);

    const outside = scratch();
    const linkId = "symlink1";
    mkdirSync(join(root, ".agent-board", "worktrees"), { recursive: true });
    symlinkSync(outside, expectedWorktreePath(root, linkId));
    setNextTaskIdForTests(linkId);
    await assert.rejects(
      () => createDraft({ kind: "pi", workspaceId, prompt: "x", useGitWorktree: true }),
      (err: unknown) => {
        assert.equal((err as { statusCode?: number }).statusCode, 400);
        assert.match((err as Error).message, new RegExp(WORKTREE_UNSAFE_PATH));
        return true;
      },
    );
    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(join(outside, "README.md")), false);
  });

  it("attaches an unmatched cwd to the default workspace and still creates the worktree there", async () => {
    const root = scratch();
    initRepo(root);
    const task = await createDraft({
      kind: "pi",
      cwd: root,
      prompt: "free cwd",
      title: "free",
      useGitWorktree: true,
    });
    assert.equal(task.workspaceId, getDefaultWorkspaceId());
    assert.equal(task.cwd, expectedWorktreePath(root, task.id));
    assert.equal(task.worktree?.owned, true);
  });

  it("creates two distinct worktrees, including overlapping adds", async () => {
    const root = scratch();
    initRepo(root);
    const workspaceId = await useWorkspace(root);
    const [a, b] = await Promise.all([
      createDraft({ kind: "pi", workspaceId, prompt: "a", title: "a", useGitWorktree: true }),
      createDraft({ kind: "pi", workspaceId, prompt: "b", title: "b", useGitWorktree: true }),
    ]);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.cwd, b.cwd);
    assert.equal(a.cwd, expectedWorktreePath(root, a.id));
    assert.equal(b.cwd, expectedWorktreePath(root, b.id));
    assert.equal(git(a.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), a.worktree?.branch);
    assert.equal(git(b.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), b.worktree?.branch);
  });

  it("rolls back the worktree when durable save fails", async () => {
    const root = scratch();
    initRepo(root);
    const workspaceId = await useWorkspace(root);
    setPersistDryRunForTests(true);
    failNextPersistForTests("task", new Error("disk full"));
    setNextTaskIdForTests("rollback1");
    await assert.rejects(
      () => createDraft({
        kind: "pi",
        workspaceId,
        prompt: "save fails",
        title: "rollback",
        useGitWorktree: true,
      }),
      /persist failed/,
    );
    assert.equal(getTask("rollback1"), undefined);
    assert.equal(existsSync(expectedWorktreePath(root, "rollback1")), false);
    assert.equal(gitFails(root, ["show-ref", "--verify", "--quiet", "refs/heads/agent-board/rollback1"]), true);
  });

  it("removes a clean owned worktree on delete and keeps a dirty one", async () => {
    const root = scratch();
    initRepo(root);
    const workspaceId = await useWorkspace(root);
    const clean = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "clean",
      title: "clean",
      useGitWorktree: true,
    });
    const removed = await removeTasks([clean.id]);
    assert.deepEqual(removed.deleted, [clean.id]);
    assert.deepEqual(removed.warnings, []);
    assert.equal(getTask(clean.id), undefined);
    assert.equal(existsSync(clean.cwd), false);
    assert.equal(gitFails(root, ["show-ref", "--verify", "--quiet", `refs/heads/${clean.worktree?.branch}`]), true);

    const dirty = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "dirty",
      title: "dirty",
      useGitWorktree: true,
    });
    writeFileSync(join(dirty.cwd, "notes.txt"), "wip\n");
    const kept = await removeTasks([dirty.id]);
    assert.deepEqual(kept.deleted, [dirty.id]);
    assert.equal(kept.warnings.length, 1);
    assert.equal(kept.warnings[0]?.code, "worktree_cleanup_skipped_dirty");
    assert.equal(existsSync(join(dirty.cwd, "notes.txt")), true);
    assert.equal(gitFails(root, ["show-ref", "--verify", "--quiet", `refs/heads/${dirty.worktree?.branch}`]), false);
    assert.equal(getTask(dirty.id), undefined);
  });

  it("does not remove a worktree when path or branch metadata was replaced", async () => {
    const root = scratch();
    initRepo(root);
    const workspaceId = await useWorkspace(root);
    const task = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "tamper",
      title: "tamper",
      useGitWorktree: true,
    });
    const cwd = task.cwd;
    const branch = task.worktree!.branch;
    upsertTask({
      ...getTask(task.id)!,
      worktree: { ...task.worktree!, path: root, owned: true },
    });
    const mismatch = await removeTasks([task.id]);
    assert.equal(mismatch.warnings[0]?.code, "worktree_cleanup_skipped_mismatch");
    assert.equal(existsSync(join(cwd, "README.md")), true);
    assert.equal(existsSync(join(root, "README.md")), true);
    assert.equal(gitFails(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]), false);

    const again = await createDraft({
      kind: "pi",
      workspaceId,
      prompt: "branch",
      title: "branch",
      useGitWorktree: true,
    });
    upsertTask({
      ...getTask(again.id)!,
      worktree: { ...again.worktree!, branch: "main", owned: true },
    });
    const branchMismatch = await removeTasks([again.id]);
    assert.equal(branchMismatch.warnings[0]?.code, "worktree_cleanup_skipped_mismatch");
    assert.equal(existsSync(again.cwd), true);
    assert.equal(git(root, ["rev-parse", "--verify", "refs/heads/main"]).trim().length > 0, true);
    assert.equal(
      gitFails(root, ["show-ref", "--verify", "--quiet", `refs/heads/${again.worktree?.branch}`]),
      false,
    );
  });
});
});
