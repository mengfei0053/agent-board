import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  GIT_STATUS_LIMITS,
  GIT_STATUS_SKIP_DIRS,
  clearGitStatusCacheForTests,
  discoverGitRepos,
  gitFileLabel,
  gitReadOnlyEnv,
  parseBranchHeader,
  parseGitStatusPorcelainZ,
  workspaceGitStatus,
} from "./gitStatus.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ab-git-"));
  scratchDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: gitReadOnlyEnv({
      ...process.env,
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "tester@example.com",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "tester@example.com",
    }),
  });
}

beforeEach(() => {
  clearGitStatusCacheForTests();
});

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("parseGitStatusPorcelainZ", () => {
  it("reads branch tracking, untracked paths with spaces, and renames", () => {
    const raw = [
      "## main...origin/main [ahead 1, behind 2]",
      " M README.md",
      "?? new file.txt",
      "R  next.md",
      "README.md",
      "",
    ].join("\0");
    const parsed = parseGitStatusPorcelainZ(raw);
    assert.equal(parsed.branch.branch, "main");
    assert.equal(parsed.branch.upstream, "origin/main");
    assert.equal(parsed.branch.ahead, 1);
    assert.equal(parsed.branch.behind, 2);
    assert.equal(parsed.branch.detached, false);
    assert.equal(parsed.files.length, 3);
    assert.equal(parsed.files[0]?.code, " M");
    assert.equal(parsed.files[0]?.label, "未暂存修改");
    assert.equal(parsed.files[1]?.path, "new file.txt");
    assert.equal(parsed.files[1]?.label, "未跟踪");
    assert.equal(parsed.files[2]?.path, "next.md");
    assert.equal(parsed.files[2]?.origPath, "README.md");
    assert.equal(parsed.files[2]?.label, "已暂存重命名");
  });

  it("parses no-commits, detached, gone upstream, and a branch with no upstream", () => {
    const none = parseBranchHeader("No commits yet on main");
    assert.equal(none.noCommits, true);
    assert.equal(none.branch, "main");
    assert.equal(none.ahead, null);

    const detached = parseGitStatusPorcelainZ("## HEAD (no branch)\0");
    assert.equal(detached.branch.detached, true);
    assert.equal(detached.branch.branch, null);

    const gone = parseBranchHeader("main...origin/main [gone]");
    assert.equal(gone.upstreamGone, true);
    assert.equal(gone.ahead, 0);
    assert.equal(gone.behind, 0);

    const local = parseBranchHeader("main");
    assert.equal(local.branch, "main");
    assert.equal(local.upstream, null);
    assert.equal(local.ahead, null);
    assert.equal(local.behind, null);
  });

  it("labels staged and unstaged rows", () => {
    assert.equal(gitFileLabel("M", " "), "已暂存修改");
    assert.equal(gitFileLabel("A", "M"), "已暂存新增 · 未暂存修改");
    assert.equal(gitFileLabel("?", "?"), "未跟踪");
    assert.equal(gitFileLabel("U", "U"), "冲突");
    assert.equal(gitFileLabel("D", "D"), "冲突");
  });
});

describe("gitReadOnlyEnv", () => {
  it("drops repo-redirecting variables and forces the C locale", () => {
    const env = gitReadOnlyEnv({
      PATH: "/usr/bin",
      GIT_DIR: "/tmp/other/.git",
      GIT_WORK_TREE: "/tmp/other",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "true",
      LANG: "zh_CN.UTF-8",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_WORK_TREE, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(env.LC_ALL, "C");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });
});

describe("discoverGitRepos", () => {
  it("finds the root, nested repos, and a .git file, within the documented caps", async () => {
    const root = scratch();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "nested", "lib", ".git"), { recursive: true });
    mkdirSync(join(root, "mods"));
    writeFileSync(join(root, "mods", "sub"), "");
    mkdirSync(join(root, "mods", "subrepo"));
    writeFileSync(join(root, "mods", "subrepo", ".git"), "gitdir: /unused\n");
    mkdirSync(join(root, "node_modules", "pkg", ".git"), { recursive: true });
    mkdirSync(join(root, "vendor", "lib", ".git"), { recursive: true });
    mkdirSync(join(root, "a", "b", "c", ".git"), { recursive: true });

    const found = await discoverGitRepos(root, { maxDepth: 2 });
    const rels = found.repos.map((p) => p.slice(found.root.length + 1)).filter(Boolean);
    assert.ok(found.repos.includes(found.root));
    assert.ok(rels.includes(join("nested", "lib")));
    assert.ok(rels.includes(join("mods", "subrepo")));
    assert.ok(!rels.some((rel) => rel.includes("node_modules") || rel.includes("vendor")));
    assert.ok(!rels.some((rel) => rel.split(/[/\\]/).includes("c")));
    assert.equal(found.caps.maxDepth, 2);
    assert.equal(found.caps.maxRepos, GIT_STATUS_LIMITS.maxRepos);
    assert.equal(found.caps.maxDirs, GIT_STATUS_LIMITS.maxDirs);
    assert.equal(found.truncated, false);
  });

  it("does not follow a symlink to a repository outside the workspace", async () => {
    const base = scratch();
    const root = join(base, "ws");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(outside, ".git"), { recursive: true });
    symlinkSync(outside, join(root, "escape"));
    const found = await discoverGitRepos(root);
    assert.equal(found.repos.length, 1);
    assert.equal(found.repos[0], found.root);
    assert.ok(!found.repos.includes(outside));
  });

  it("stops at maxRepos and reports truncated", async () => {
    const root = scratch();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "a", ".git"), { recursive: true });
    mkdirSync(join(root, "b", ".git"), { recursive: true });
    const found = await discoverGitRepos(root, { maxRepos: 2 });
    assert.equal(found.repos.length, 2);
    assert.equal(found.truncated, true);
    assert.equal(found.repos[1], join(found.root, "a"));
  });

  it("rejects a missing path", async () => {
    await assert.rejects(() => discoverGitRepos(join(scratch(), "missing")), /path not found/);
  });
});

describe("workspaceGitStatus", () => {
  it("reports nested repos, dirty files, and ignores GIT_DIR", async () => {
    const root = scratch();
    const decoy = scratch();
    git(decoy, ["init", "-b", "main"]);
    writeFileSync(join(decoy, "decoy.txt"), "nope\n");
    git(decoy, ["add", "decoy.txt"]);
    git(decoy, ["commit", "-m", "decoy commit"]);

    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "README.md"), "a\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "init readme"]);
    writeFileSync(join(root, "README.md"), "b\n");
    writeFileSync(join(root, "new file.txt"), "x\n");

    const nested = join(root, "pkgs", "lib");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-b", "dev"]);
    writeFileSync(join(nested, "lib.txt"), "lib\n");
    git(nested, ["add", "lib.txt"]);
    git(nested, ["commit", "-m", "lib init"]);

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy, ".git");
    try {
      const status = await workspaceGitStatus(root, { refresh: true });
      assert.equal(status.root, root);
      assert.equal(status.cached, false);
      assert.equal(status.repos.length, 2);
      const top = status.repos.find((repo) => repo.relPath === ".");
      const child = status.repos.find((repo) => repo.relPath === join("pkgs", "lib"));
      assert.ok(top);
      assert.equal(top?.error, null);
      assert.equal(top?.branch, "main");
      assert.equal(top?.dirty, true);
      assert.equal(top?.subject, "init readme");
      assert.match(top?.head ?? "", /^[0-9a-f]{4,}$/);
      assert.equal(top?.ahead, null);
      assert.ok(top?.files.some((file) => file.path === "README.md" && file.code === " M"));
      assert.ok(top?.files.some((file) => file.path === "new file.txt" && file.label === "未跟踪"));
      assert.equal(top?.subject?.includes("decoy"), false);

      assert.ok(child);
      assert.equal(child?.branch, "dev");
      assert.equal(child?.dirty, false);
      assert.equal(child?.subject, "lib init");
      assert.equal(child?.noCommits, false);

      const again = await workspaceGitStatus(root);
      assert.equal(again.cached, true);
      assert.equal(again.repos[0]?.subject, "init readme");

      writeFileSync(join(root, "later.txt"), "z\n");
      const stale = await workspaceGitStatus(root);
      assert.equal(stale.cached, true);
      assert.equal(
        stale.repos.find((repo) => repo.relPath === ".")?.files.some((file) => file.path === "later.txt"),
        false,
      );
      const fresh = await workspaceGitStatus(root, { refresh: true });
      assert.equal(fresh.cached, false);
      assert.equal(
        fresh.repos.find((repo) => repo.relPath === ".")?.files.some((file) => file.path === "later.txt"),
        true,
      );
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("reports ahead/behind and a linked worktree", async () => {
    const root = scratch();
    const bare = scratch();
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "-m", "base"]);
    git(bare, ["init", "--bare"]);
    git(root, ["remote", "add", "origin", bare]);
    git(root, ["push", "-u", "origin", "main"]);
    writeFileSync(join(root, "a.txt"), "b\n");
    git(root, ["commit", "-am", "second"]);
    git(root, ["worktree", "add", "-b", "feature", join(root, "wt"), "HEAD"]);

    const status = await workspaceGitStatus(root, { refresh: true });
    const top = status.repos.find((repo) => repo.relPath === ".");
    assert.equal(top?.ahead, 1);
    assert.equal(top?.behind, 0);
    assert.equal(top?.upstream, "origin/main");
    assert.ok(top?.files.some((file) => file.path === "wt/" && file.label === "未跟踪"));
    const wt = status.repos.find((repo) => repo.relPath === "wt");
    assert.equal(wt?.branch, "feature");
    assert.equal(wt?.dirty, false);
    assert.equal(wt?.error, null);
  });

  it("returns no repos for a directory that is not a git checkout", async () => {
    const root = scratch();
    writeFileSync(join(root, "note.txt"), "hi\n");
    const status = await workspaceGitStatus(root, { refresh: true });
    assert.deepEqual(status.repos, []);
    assert.equal(status.truncated, false);
    assert.equal(status.caps.maxDepth, GIT_STATUS_LIMITS.maxDepth);
    assert.equal(status.caps.maxRepos, 32);
    assert.equal(status.caps.maxDirs, 4_000);
  });

  it("does not discover repositories under .agent-board", async () => {
    const root = scratch();
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "README.md"), "hi\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "init"]);
    const nested = join(root, ".agent-board", "worktrees", "nested");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-b", "main"]);
    writeFileSync(join(nested, "inside.txt"), "x\n");
    git(nested, ["add", "inside.txt"]);
    git(nested, ["commit", "-m", "nested"]);
    git(root, ["worktree", "add", "-b", "agent-board/skipme", join(root, ".agent-board", "worktrees", "skipme"), "HEAD"]);

    const found = await discoverGitRepos(root);
    assert.equal(found.repos.length, 1);
    assert.equal(found.repos.some((repo) => repo.includes(".agent-board")), false);
    const status = await workspaceGitStatus(root, { refresh: true });
    assert.equal(status.repos.some((repo) => repo.relPath.includes(".agent-board")), false);
    assert.ok(GIT_STATUS_SKIP_DIRS.includes(".agent-board"));
  });

  it("truncates the per-repo file list", async () => {
    const root = scratch();
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "one.txt"), "1\n");
    writeFileSync(join(root, "two.txt"), "2\n");
    const status = await workspaceGitStatus(root, { refresh: true, limits: { maxFilesPerRepo: 1 } });
    const top = status.repos[0];
    assert.equal(top?.files.length, 1);
    assert.equal(top?.fileCount, 2);
    assert.equal(top?.filesTruncated, true);
    assert.equal(top?.dirty, true);
  });
});
