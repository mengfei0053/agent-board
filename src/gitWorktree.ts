import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { HttpError } from "./httpError.js";
import { GIT_STATUS_LIMITS, gitReadOnlyEnv } from "./gitStatus.js";
import { resolveAllowedDirectory } from "./paths.js";
import { spawnCollect, type SpawnCollectResult } from "./spawnCollect.js";

/** Read probes share the git-status deadline and byte cap. */
const READ_TIMEOUT_MS = GIT_STATUS_LIMITS.gitTimeoutMs;
const MAX_GIT_BYTES = GIT_STATUS_LIMITS.maxGitBytes;
/**
 * `worktree add` checks out a full tree, so it cannot share the short status
 * probe deadline. Still bounded.
 */
const MUTATE_TIMEOUT_MS = 30_000;

export const WORKTREE_NOT_ROOT = "cwd is not a git work tree root";
export const WORKTREE_UNBORN = "repository has no commits";
export const WORKTREE_DEST_EXISTS = "worktree destination already exists";
export const WORKTREE_BRANCH_EXISTS = "worktree branch already exists";
export const WORKTREE_UNSAFE_PATH = "worktree path is not a safe directory";

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type GitWorktreeEligibility =
  | { ok: true; root: string; head: string }
  | { ok: false; reason: string };

export type OwnedWorktreeCleanup = {
  taskId: string;
  path: string;
  branch: string;
  owned: true;
};

export type WorktreeCleanupWarning = {
  taskId: string;
  code:
    | "worktree_cleanup_skipped_dirty"
    | "worktree_cleanup_skipped_mismatch"
    | "worktree_cleanup_failed"
    | "worktree_branch_delete_failed";
  message: string;
};

type ListedWorktree = {
  path: string;
  head: string | null;
  branch: string | null;
};

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function assertSafeTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) throw new HttpError(400, "invalid task id for worktree");
}

export function worktreeBranchName(taskId: string): string {
  assertSafeTaskId(taskId);
  return `agent-board/${taskId}`;
}

export function expectedWorktreePath(baseReal: string, taskId: string): string {
  assertSafeTaskId(taskId);
  return join(baseReal, ".agent-board", "worktrees", taskId);
}

function spawnGit(cwd: string, args: string[], timeoutMs: number): Promise<SpawnCollectResult> {
  return spawnCollect("git", ["-C", cwd, ...args], {
    cwd,
    env: gitReadOnlyEnv(),
    timeoutMs,
    maxBytes: MAX_GIT_BYTES,
  });
}

/** Timeout or a failed spawn is a server error. A non-zero git exit is returned. */
function crashIfSpawnFailed(result: SpawnCollectResult, what: string): void {
  if (result.timedOut) throw new HttpError(500, `git ${what} timed out`);
  if (result.code === null) {
    throw new HttpError(500, `git ${what} failed: ${clip(result.stderr) || "spawn failed"}`);
  }
}

function isUnbornHead(result: SpawnCollectResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return /unknown revision|ambiguous argument|bad revision|needed a single revision|not a valid object name/i.test(text);
}

/**
 * Eligible only when `absPath` is an allowed directory, is the git work tree
 * root (realpath equals `rev-parse --show-toplevel`), and HEAD resolves.
 * Unborn repositories are ineligible. Every git spawn scrubs `GIT_*`.
 */
export async function getGitWorktreeEligibility(absPath: string): Promise<GitWorktreeEligibility> {
  const root = resolveAllowedDirectory(absPath, "cwd");
  const inside = await spawnGit(root, ["rev-parse", "--is-inside-work-tree"], READ_TIMEOUT_MS);
  crashIfSpawnFailed(inside, "rev-parse");
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, reason: WORKTREE_NOT_ROOT };
  }

  const top = await spawnGit(root, ["rev-parse", "--show-toplevel"], READ_TIMEOUT_MS);
  crashIfSpawnFailed(top, "rev-parse");
  if (top.code !== 0) return { ok: false, reason: WORKTREE_NOT_ROOT };
  let topReal: string;
  try {
    topReal = await realpath(top.stdout.trim());
  } catch {
    return { ok: false, reason: WORKTREE_NOT_ROOT };
  }
  if (topReal !== root) return { ok: false, reason: WORKTREE_NOT_ROOT };

  const head = await spawnGit(root, ["rev-parse", "HEAD"], READ_TIMEOUT_MS);
  crashIfSpawnFailed(head, "rev-parse");
  const sha = head.stdout.trim();
  if (head.code !== 0 || !SHA_RE.test(sha)) {
    if (head.code !== 0 && !isUnbornHead(head)) {
      throw new HttpError(500, `git rev-parse HEAD failed: ${clip(head.stderr) || clip(head.stdout) || "no HEAD"}`);
    }
    return { ok: false, reason: WORKTREE_UNBORN };
  }
  return { ok: true, root, head: sha };
}

type DestState = "absent" | "exists" | "unsafe";

async function inspectDest(baseReal: string, taskId: string): Promise<DestState> {
  let cur = baseReal;
  for (const part of [".agent-board", "worktrees", taskId]) {
    cur = join(cur, part);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) return "unsafe";
      if (part === taskId) return "exists";
      if (!st.isDirectory()) return "exists";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "absent";
      throw new HttpError(500, `worktree path check failed: ${code || "fs"}`);
    }
  }
  return "absent";
}

function throwDestState(state: DestState): void {
  if (state === "unsafe") throw new HttpError(400, WORKTREE_UNSAFE_PATH);
  if (state === "exists") throw new HttpError(400, WORKTREE_DEST_EXISTS);
}

async function ensureWorktreeParents(baseReal: string): Promise<void> {
  let cur = baseReal;
  for (const part of [".agent-board", "worktrees"]) {
    cur = join(cur, part);
    let st: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      st = await lstat(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new HttpError(500, `worktree path check failed: ${code || "fs"}`);
    }
    if (st?.isSymbolicLink()) throw new HttpError(400, WORKTREE_UNSAFE_PATH);
    if (st && !st.isDirectory()) throw new HttpError(400, WORKTREE_DEST_EXISTS);
    if (!st) {
      try {
        await mkdir(cur);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw new HttpError(500, `could not create worktree parent: ${code || "fs"}`);
        const again = await lstat(cur);
        if (again.isSymbolicLink()) throw new HttpError(400, WORKTREE_UNSAFE_PATH);
        if (!again.isDirectory()) throw new HttpError(400, WORKTREE_DEST_EXISTS);
      }
    }
  }
}

function parseWorktreeList(text: string): ListedWorktree[] {
  const rows: ListedWorktree[] = [];
  let cur: ListedWorktree | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) rows.push(cur);
      cur = { path: line.slice("worktree ".length), head: null, branch: null };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length);
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

async function worktreeIsListed(baseReal: string, expectedPath: string, branch: string): Promise<boolean> {
  const listed = await spawnGit(baseReal, ["worktree", "list", "--porcelain"], READ_TIMEOUT_MS);
  crashIfSpawnFailed(listed, "worktree list");
  if (listed.code !== 0) {
    throw new HttpError(500, `git worktree list failed: ${clip(listed.stderr) || `exit ${listed.code}`}`);
  }
  const ref = `refs/heads/${branch}`;
  for (const row of parseWorktreeList(listed.stdout)) {
    if (row.branch !== ref) continue;
    let rowReal: string;
    try {
      rowReal = await realpath(row.path);
    } catch {
      continue;
    }
    if (rowReal === expectedPath) return true;
  }
  return false;
}

async function worktreeIsDirty(path: string): Promise<boolean> {
  const status = await spawnGit(path, ["status", "--porcelain"], READ_TIMEOUT_MS);
  crashIfSpawnFailed(status, "status");
  if (status.code !== 0) {
    throw new HttpError(500, `git status failed: ${clip(status.stderr) || `exit ${status.code}`}`);
  }
  return status.stdout.trim().length > 0;
}

/** Remove a directory only when it is empty, real, and not a symlink. */
async function removeEmptyRealDir(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    const real = await realpath(path);
    if (real !== path) return;
    await rm(path, { recursive: false });
  } catch {
    /* not empty, missing, or raced — leave it */
  }
}

function warn(taskId: string, code: WorktreeCleanupWarning["code"], message: string): WorktreeCleanupWarning {
  const warning = { taskId, code, message };
  console.warn(`[worktree] ${code} task=${taskId} ${message}`);
  return warning;
}

function insideBase(baseReal: string, targetReal: string): boolean {
  return targetReal === baseReal || targetReal.startsWith(baseReal + sep);
}

/**
 * Add `agent-board/<taskId>` at `<base>/.agent-board/worktrees/<taskId>` from HEAD.
 * Refuses an existing destination or branch. On a failed add, rolls back only a
 * worktree this call registered (clean, listed, expected path). Never deletes a
 * pre-existing directory or branch.
 */
export async function addOwnedWorktree(
  base: string,
  taskId: string,
  baseHead: string,
): Promise<{ path: string; branch: string; baseHead: string }> {
  assertSafeTaskId(taskId);
  const branch = worktreeBranchName(taskId);
  let baseReal: string;
  try {
    baseReal = await realpath(base);
  } catch {
    throw new HttpError(500, "worktree base path disappeared");
  }
  const dest = expectedWorktreePath(baseReal, taskId);
  throwDestState(await inspectDest(baseReal, taskId));

  const branchCheck = await spawnGit(baseReal, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], READ_TIMEOUT_MS);
  crashIfSpawnFailed(branchCheck, "show-ref");
  if (branchCheck.code === 0) throw new HttpError(400, WORKTREE_BRANCH_EXISTS);
  if (branchCheck.code !== 1) {
    throw new HttpError(500, `git show-ref failed: ${clip(branchCheck.stderr) || `exit ${branchCheck.code}`}`);
  }

  await ensureWorktreeParents(baseReal);
  throwDestState(await inspectDest(baseReal, taskId));

  let added: SpawnCollectResult | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await inspectDest(baseReal, taskId);
    if (state !== "absent") {
      if (added) break;
      throwDestState(state);
    }
    added = await spawnGit(baseReal, ["worktree", "add", "-b", branch, dest, "HEAD"], MUTATE_TIMEOUT_MS);
    if (added.code === 0 && !added.timedOut) break;
    const locked = /index\.lock|Unable to create/i.test(added.stderr);
    if (!locked || added.timedOut || added.code === null || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  if (!added || added.timedOut || added.code === null || added.code !== 0) {
    await rollbackFailedAdd(baseReal, taskId, branch, dest);
    if (added && /a branch named .+ already exists/i.test(added.stderr)) {
      throw new HttpError(400, WORKTREE_BRANCH_EXISTS);
    }
    if (added && /already exists/i.test(added.stderr)) {
      throw new HttpError(400, WORKTREE_DEST_EXISTS);
    }
    const detail = added
      ? (added.timedOut ? "timed out" : clip(added.stderr) || (added.code === null ? "spawn failed" : `exit ${added.code}`))
      : "no result";
    throw new HttpError(500, `git worktree add failed: ${detail}`);
  }
  return { path: dest, branch, baseHead };
}

/**
 * After a failed `worktree add`, remove the worktree only when it is listed
 * for this exact path and branch and is clean. An unregistered empty directory
 * we just created can be removed. A pre-existing branch is left alone unless
 * we successfully removed the worktree that checked it out.
 */
async function rollbackFailedAdd(baseReal: string, taskId: string, branch: string, dest: string): Promise<void> {
  try {
    let listed = false;
    try {
      listed = await worktreeIsListed(baseReal, dest, branch);
    } catch (err) {
      console.warn(`[worktree] rollback list failed task=${taskId}`, err instanceof Error ? err.message : err);
      return;
    }
    if (listed) {
      let dirty = true;
      try {
        dirty = await worktreeIsDirty(dest);
      } catch (err) {
        console.warn(`[worktree] rollback status failed task=${taskId}`, err instanceof Error ? err.message : err);
        return;
      }
      if (dirty) {
        console.warn(`[worktree] rollback skipped dirty task=${taskId}`);
        return;
      }
      const removed = await spawnGit(baseReal, ["worktree", "remove", dest], MUTATE_TIMEOUT_MS);
      if (removed.timedOut || removed.code !== 0) {
        console.warn(`[worktree] rollback remove failed task=${taskId} ${clip(removed.stderr)}`);
        return;
      }
      const branchDel = await spawnGit(baseReal, ["branch", "-D", branch], MUTATE_TIMEOUT_MS);
      if (branchDel.code !== 0 && !/not found/i.test(branchDel.stderr)) {
        console.warn(`[worktree] rollback branch delete failed task=${taskId} ${clip(branchDel.stderr)}`);
      }
      return;
    }
    await removeEmptyRealDir(dest);
  } catch (err) {
    console.warn(`[worktree] rollback failed task=${taskId}`, err instanceof Error ? err.message : err);
  }
}

async function chainIsReal(baseReal: string, taskId: string): Promise<boolean> {
  let cur = baseReal;
  for (const part of [".agent-board", "worktrees", taskId]) {
    cur = join(cur, part);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  try {
    return (await realpath(cur)) === cur;
  } catch {
    return false;
  }
}

/**
 * Best-effort delete of a board-owned worktree. Skips when the path or branch
 * does not match `<base>/.agent-board/worktrees/<taskId>` / `agent-board/<taskId>`,
 * when the path is not listed for that base, or when the tree is dirty.
 * Does not use `worktree remove --force`. Does not fail the caller.
 */
export async function cleanupOwnedWorktree(input: OwnedWorktreeCleanup): Promise<WorktreeCleanupWarning | null> {
  if (input.owned !== true) return null;
  try {
    return await cleanupOwnedWorktreeBody(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return warn(input.taskId, "worktree_cleanup_failed", message);
  }
}

async function cleanupOwnedWorktreeBody(input: OwnedWorktreeCleanup): Promise<WorktreeCleanupWarning | null> {
  const { taskId, path } = input;
  let expectedBranch: string;
  try {
    expectedBranch = worktreeBranchName(taskId);
  } catch {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }
  if (input.branch !== expectedBranch || !isAbsolute(path)) {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }
  const suffix = `${sep}.agent-board${sep}worktrees${sep}${taskId}`;
  if (!path.endsWith(suffix)) {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }
  const baseLexical = path.slice(0, -suffix.length);
  if (!baseLexical) {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }

  let baseReal: string;
  try {
    baseReal = await realpath(baseLexical);
  } catch {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }
  const expected = expectedWorktreePath(baseReal, taskId);
  if (!(await chainIsReal(baseReal, taskId))) {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }
  let storedReal: string;
  try {
    storedReal = await realpath(path);
  } catch {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }
  if (storedReal !== expected || !insideBase(baseReal, storedReal)) {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }

  const listed = await worktreeIsListed(baseReal, expected, expectedBranch);
  if (!listed) {
    return warn(taskId, "worktree_cleanup_skipped_mismatch", "worktree path or branch does not match the owned task directory; skipped removal");
  }
  if (await worktreeIsDirty(expected)) {
    return warn(taskId, "worktree_cleanup_skipped_dirty", "worktree has uncommitted changes; left the directory in place");
  }

  const removed = await spawnGit(baseReal, ["worktree", "remove", expected], MUTATE_TIMEOUT_MS);
  crashIfSpawnFailed(removed, "worktree remove");
  if (removed.code !== 0) {
    return warn(taskId, "worktree_cleanup_failed", `git worktree remove failed: ${clip(removed.stderr) || `exit ${removed.code}`}`);
  }

  const branchDel = await spawnGit(baseReal, ["branch", "-D", expectedBranch], MUTATE_TIMEOUT_MS);
  crashIfSpawnFailed(branchDel, "branch");
  if (branchDel.code !== 0 && !/not found/i.test(branchDel.stderr)) {
    return warn(taskId, "worktree_branch_delete_failed", `git branch -D failed: ${clip(branchDel.stderr) || `exit ${branchDel.code}`}`);
  }
  return null;
}
