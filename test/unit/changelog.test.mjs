import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateChangelog } from "../../scripts/generate-changelog.mjs";

const script = fileURLToPath(new URL("../../scripts/generate-changelog.mjs", import.meta.url));

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "agent-board-changelog-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Changelog Test");
  const commit = (subject) => git("commit", "--allow-empty", "-m", subject);
  const read = (filename = "CHANGELOG.md", dir = cwd) => readFileSync(join(dir, filename), "utf8");
  return { cwd, git, commit, read };
}

test("generates bilingual, grouped cumulative logs and is deterministic", (t) => {
  const { cwd, git, commit, read } = repository(t);
  commit("feat(core): initial board");
  git("tag", "1.0.0");
  commit("fix(web): correct task sorting");
  commit("perf: reduce polling");
  commit("docs: update guide");
  commit("chore: refresh dependencies");
  commit("feat(api)!: replace protocol");
  commit("修复中文任务显示");
  git("tag", "-a", "v1.1.0", "-m", "Release 1.1.0");
  git("tag", "not-a-version");
  commit("feat: pending change");

  const releases = generateChangelog({ cwd });
  assert.equal(releases.length, 3);
  assert.equal(releases[1].version, "v1.1.0");
  const english = read();
  const chinese = read("CHANGELOG.zh.md");
  assert.match(english, /^# Changelog\n/);
  assert.match(english, /## Unreleased \(\d{4}-\d{2}-\d{2}\)/);
  assert.match(chinese, /^# 更新日志\n/);
  assert.match(chinese, /## 未发布 /);
  for (const heading of ["Features", "Bug fixes", "Performance", "Documentation", "Other changes"]) {
    assert.ok(english.includes(`### ${heading}`));
  }
  for (const heading of ["新增功能", "问题修复", "性能优化", "文档更新", "其他变更"]) {
    assert.ok(chinese.includes(`### ${heading}`));
  }
  assert.match(english, /\*\*api\*\*: replace protocol ⚠ BREAKING CHANGE/);
  assert.match(chinese, /修复中文任务显示/);
  assert.match(english, /\(`[a-f0-9]{7,}`\)/);
  assert.ok(english.indexOf("## v1.1.0") < english.indexOf("## 1.0.0"));
  assert.equal(english.match(/initial board/g).length, 1);
  assert.doesNotMatch(english, /not-a-version/);
  generateChangelog({ cwd });
  assert.equal(read(), english);
  assert.equal(read("CHANGELOG.zh.md"), chinese);
});

test("CLI selects a historical tag and supports a separate output directory", (t) => {
  const { cwd, git, commit, read } = repository(t);
  commit("feat: first release");
  git("tag", "1.0.0");
  commit("fix: later change");
  const outputDir = join(cwd, "output");
  const result = spawnSync(process.execPath, [script, "--ref", "1.0.0", "--output-dir", outputDir], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(read("CHANGELOG.md", outputDir), /## 1.0.0/);
  assert.doesNotMatch(read("CHANGELOG.md", outputDir), /Unreleased|later change/);
  assert.match(read("CHANGELOG.zh.md", outputDir), /新增功能/);
});

test("handles repositories without tags and empty release ranges", (t) => {
  const { cwd, git, commit, read } = repository(t);
  commit("initial setup");
  generateChangelog({ cwd });
  assert.match(read(), /## Unreleased/);
  git("tag", "1.0.0");
  const initial = git("rev-parse", "HEAD");
  commit("fix: follow-up");
  git("tag", "1.1.0");
  // This merge introduces no commits beyond the previous release.
  const merge = git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-p", initial, "-m", "Empty merge");
  git("update-ref", "refs/heads/main", merge);
  git("tag", "1.2.0");
  git("tag", "v1.2.0");
  generateChangelog({ cwd });
  assert.match(read(), /## 1.2.0 \/ v1.2.0[^\n]*\n\nNo changes\./);
  assert.match(read("CHANGELOG.zh.md"), /无变更。/);
});

test("includes merged changes without treating side-branch tags as release boundaries", (t) => {
  const { cwd, git, commit, read } = repository(t);
  commit("feat: initial");
  git("tag", "1.0.0");
  git("checkout", "-b", "feature");
  commit("feat: side branch feature");
  git("tag", "9.0.0");
  git("checkout", "main");
  commit("fix: mainline fix");
  git("merge", "--no-ff", "feature", "-m", "Merge feature");
  git("tag", "1.1.0");
  generateChangelog({ cwd });
  assert.match(read(), /side branch feature/);
  assert.match(read(), /mainline fix/);
  assert.doesNotMatch(read(), /Merge feature|9\.0\.0/);
  assert.equal(read().match(/initial \(`/g).length, 1);
});

test("rejects invalid refs, shallow history, and invalid CLI arguments", (t) => {
  const { cwd, commit } = repository(t);
  commit("feat: initial");
  assert.throws(() => generateChangelog({ cwd, ref: "missing" }));
  assert.throws(() => generateChangelog({ cwd, ref: "--all" }));
  for (const args of [["--unknown"], ["--ref"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const shallow = join(cwd, "shallow");
  execFileSync("git", ["clone", "--depth", "1", `file://${cwd}`, shallow], { stdio: "pipe" });
  assert.throws(() => generateChangelog({ cwd: shallow }), /full Git history/);
});
