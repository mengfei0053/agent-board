import { readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { HttpError } from "./httpError.js";
import { isInsideRoot } from "./paths.js";
import { spawnCollect } from "./spawnCollect.js";

/**
 * Caps for workspace git discovery. The walk stops when any cap is hit so a
 * huge tree cannot hang the API. The same numbers are returned as `caps`.
 *
 * - maxDepth: workspace root is depth 0. Directories deeper than this are not entered.
 * - maxRepos: maximum repositories returned (root + nested / submodule / extra .git).
 * - maxDirs: maximum directories visited, including ones that are not repos.
 * - maxFilesPerRepo: porcelain rows kept per repository (`filesTruncated` if more).
 *
 * Directories named in `GIT_STATUS_SKIP_DIRS` are never entered. That skips
 * `node_modules`, `.git` internals, `.agent-board` (board-owned worktrees),
 * and common large vendor / build trees, so a nested clone inside those
 * folders is not reported.
 */
export const GIT_STATUS_LIMITS = {
  maxDepth: 6,
  maxRepos: 32,
  maxDirs: 4_000,
  maxFilesPerRepo: 200,
  gitTimeoutMs: 4_000,
  cacheTtlMs: 3_000,
  concurrency: 4,
  maxGitBytes: 200_000,
} as const;

export const GIT_STATUS_SKIP_DIRS: readonly string[] = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  ".turbo",
  ".yarn",
  "bower_components",
  "Pods",
  ".git",
  ".hg",
  ".svn",
  ".agent-board",
];

const SKIP_DIRS = new Set(GIT_STATUS_SKIP_DIRS);

/** Env vars that would retarget git away from `-C <repo>`. */
const GIT_ENV_BLOCKLIST = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

export type GitFileStatus = {
  /** Porcelain XY code, e.g. " M", "M ", "??", "R ". */
  code: string;
  x: string;
  y: string;
  path: string;
  /** Previous path when the row is a rename or copy. */
  origPath?: string;
  label: string;
};

export type GitRepoStatus = {
  path: string;
  /** "." when the repository is the workspace root. */
  relPath: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  /** Null when the branch has no upstream. */
  ahead: number | null;
  behind: number | null;
  upstreamGone: boolean;
  dirty: boolean;
  /** Short HEAD sha. Null when the branch has no commits. */
  head: string | null;
  subject: string | null;
  noCommits: boolean;
  files: GitFileStatus[];
  fileCount: number;
  filesTruncated: boolean;
  error: string | null;
};

export type GitStatusCaps = {
  maxDepth: number;
  maxRepos: number;
  maxDirs: number;
  maxFilesPerRepo: number;
};

export type GitWorkspaceStatus = {
  root: string;
  repos: GitRepoStatus[];
  truncated: boolean;
  scannedDirs: number;
  caps: GitStatusCaps;
  cached: boolean;
};

export type DiscoverGitReposResult = {
  root: string;
  repos: string[];
  truncated: boolean;
  scannedDirs: number;
  caps: GitStatusCaps;
};

type LimitOverrides = {
  maxDepth?: number;
  maxRepos?: number;
  maxDirs?: number;
  maxFilesPerRepo?: number;
};

const cache = new Map<string, { at: number; value: GitWorkspaceStatus }>();
const inflight = new Map<string, Promise<GitWorkspaceStatus>>();

export function clearGitStatusCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

export function gitReadOnlyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
      delete env[key];
    }
  }
  for (const key of GIT_ENV_BLOCKLIST) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

const STAGED_LABEL: Record<string, string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  R: "重命名",
  C: "复制",
  T: "类型变更",
  U: "冲突",
};

const UNSTAGED_LABEL: Record<string, string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  T: "类型变更",
  U: "冲突",
};

export function gitFileLabel(x: string, y: string): string {
  if (x === "?" && y === "?") return "未跟踪";
  if (x === "!" && y === "!") return "已忽略";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "冲突";
  }
  const parts: string[] = [];
  if (x !== " " && x !== "?") parts.push(`已暂存${STAGED_LABEL[x] || x}`);
  if (y !== " " && y !== "?") parts.push(`未暂存${UNSTAGED_LABEL[y] || y}`);
  return parts.join(" · ") || `${x}${y}`;
}

export type ParsedBranch = {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  upstreamGone: boolean;
  noCommits: boolean;
};

/** Parse the `## …` header from `git status --porcelain=v1 -b` (C locale). */
export function parseBranchHeader(line: string | null): ParsedBranch {
  const empty: ParsedBranch = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    noCommits: false,
  };
  if (!line) return empty;
  if (line.startsWith("No commits yet on ")) {
    return {
      ...empty,
      branch: line.slice("No commits yet on ".length).trim() || null,
      noCommits: true,
    };
  }
  let rest = line;
  let ahead: number | null = null;
  let behind: number | null = null;
  let upstreamGone = false;
  const bracket = /^(.*) \[(.*)\]$/.exec(rest);
  if (bracket) {
    rest = bracket[1];
    const inside = bracket[2];
    const aheadMatch = /ahead (\d+)/.exec(inside);
    const behindMatch = /behind (\d+)/.exec(inside);
    if (aheadMatch) ahead = Number(aheadMatch[1]);
    if (behindMatch) behind = Number(behindMatch[1]);
    if (inside.split(/,\s*/).includes("gone")) upstreamGone = true;
  }
  let branch = rest;
  let upstream: string | null = null;
  const dots = rest.indexOf("...");
  if (dots >= 0) {
    branch = rest.slice(0, dots);
    upstream = rest.slice(dots + 3) || null;
    if (ahead === null) ahead = 0;
    if (behind === null) behind = 0;
  }
  const detached = branch === "HEAD (no branch)";
  return {
    branch: detached ? null : branch || null,
    detached,
    upstream,
    ahead: upstream ? ahead : null,
    behind: upstream ? behind : null,
    upstreamGone,
    noCommits: false,
  };
}

export type ParsedPorcelain = {
  branch: ParsedBranch;
  files: GitFileStatus[];
};

/**
 * Parse `git status --porcelain=v1 -b -z` (NUL-separated).
 * Rename/copy records are `XY <new>\\0<old>\\0`.
 */
export function parseGitStatusPorcelainZ(stdout: string): ParsedPorcelain {
  const parts = stdout.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  let branchLine: string | null = null;
  let i = 0;
  if (parts[0]?.startsWith("##")) {
    branchLine = parts[0].replace(/^##\s?/, "");
    i = 1;
  }
  const files: GitFileStatus[] = [];
  while (i < parts.length) {
    const rec = parts[i] ?? "";
    if (rec.length < 3 || rec[2] !== " ") {
      i += 1;
      continue;
    }
    const x = rec[0] ?? " ";
    const y = rec[1] ?? " ";
    const path = rec.slice(3);
    let origPath: string | undefined;
    const renamed = x === "R" || x === "C" || y === "R" || y === "C";
    if (renamed) {
      const oldPath = parts[i + 1];
      if (oldPath !== undefined) origPath = oldPath;
      i += 2;
    } else {
      i += 1;
    }
    if (!path) continue;
    const row: GitFileStatus = {
      code: `${x}${y}`,
      x,
      y,
      path,
      label: gitFileLabel(x, y),
    };
    if (origPath) row.origPath = origPath;
    files.push(row);
  }
  return { branch: parseBranchHeader(branchLine), files };
}

function capsOf(limits: LimitOverrides): GitStatusCaps {
  return {
    maxDepth: limits.maxDepth ?? GIT_STATUS_LIMITS.maxDepth,
    maxRepos: limits.maxRepos ?? GIT_STATUS_LIMITS.maxRepos,
    maxDirs: limits.maxDirs ?? GIT_STATUS_LIMITS.maxDirs,
    maxFilesPerRepo: limits.maxFilesPerRepo ?? GIT_STATUS_LIMITS.maxFilesPerRepo,
  };
}

async function isGitMarker(dir: string, ent: Dirent): Promise<boolean> {
  if (ent.isFile() || ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  try {
    const st = await stat(join(dir, ent.name));
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

async function isDirectoryEntry(dir: string, ent: Dirent): Promise<boolean> {
  if (ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  try {
    const st = await stat(join(dir, ent.name));
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk `root` for `.git` files or directories. Does not follow a path whose
 * realpath leaves `root`. Does not enter `GIT_STATUS_SKIP_DIRS`.
 */
export async function discoverGitRepos(
  rootInput: string,
  limits: LimitOverrides = {},
): Promise<DiscoverGitReposResult> {
  const caps = capsOf(limits);
  let root: string;
  try {
    root = await realpath(rootInput);
  } catch {
    throw new HttpError(400, "path not found");
  }
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    throw new HttpError(400, "path not found");
  }
  if (!rootStat.isDirectory()) {
    throw new HttpError(400, "path is not a directory");
  }

  const repos: string[] = [];
  const seen = new Set<string>();
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let qi = 0;
  let scannedDirs = 0;
  let hitCap = false;

  while (qi < queue.length) {
    if (repos.length >= caps.maxRepos || scannedDirs >= caps.maxDirs) {
      hitCap = true;
      break;
    }
    const current = queue[qi];
    qi += 1;
    if (!current) break;
    let real: string;
    try {
      real = await realpath(current.dir);
    } catch {
      continue;
    }
    if (!isInsideRoot(root, real) || seen.has(real)) continue;
    seen.add(real);
    scannedDirs += 1;
    if (scannedDirs % 250 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    let entries: Dirent[];
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      continue;
    }
    const gitEnt = entries.find((ent) => ent.name === ".git");
    if (gitEnt && (await isGitMarker(real, gitEnt))) repos.push(real);
    if (current.depth >= caps.maxDepth) continue;

    const children = entries
      .filter((ent) => ent.name !== ".git" && !SKIP_DIRS.has(ent.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of children) {
      if (!(await isDirectoryEntry(real, ent))) continue;
      queue.push({ dir: join(real, ent.name), depth: current.depth + 1 });
    }
  }

  return {
    root,
    repos,
    truncated: hitCap && qi < queue.length,
    scannedDirs,
    caps,
  };
}

function relOf(root: string, repoPath: string): string | null {
  const rel = relative(root, repoPath);
  if (!rel) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (rel.split(sep).includes("..")) return null;
  return rel;
}

function emptyRepo(path: string, relPath: string, error: string | null): GitRepoStatus {
  return {
    path,
    relPath,
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    dirty: false,
    head: null,
    subject: null,
    noCommits: false,
    files: [],
    fileCount: 0,
    filesTruncated: false,
    error,
  };
}

function gitFailureMessage(stderr: string, code: number | null, timedOut: boolean): string {
  if (timedOut) return "git 超时";
  const text = stderr.trim();
  if (/ENOENT|not found/i.test(text)) return "未找到 git 命令";
  if (text) return text.split("\n")[0]?.slice(0, 300) || "git 失败";
  if (code == null) return "git 失败";
  return `git 退出码 ${code}`;
}

async function readRepoStatus(
  root: string,
  repoPath: string,
  maxFiles: number,
): Promise<GitRepoStatus> {
  const relPath = relOf(root, repoPath);
  if (!relPath) return emptyRepo(repoPath, ".", "仓库路径超出工作区");
  let inside = false;
  try {
    inside = isInsideRoot(root, await realpath(repoPath));
  } catch {
    inside = false;
  }
  if (!inside) return emptyRepo(repoPath, relPath, "仓库路径超出工作区");

  const env = gitReadOnlyEnv();
  const maxBytes = GIT_STATUS_LIMITS.maxGitBytes;
  const [status, log] = await Promise.all([
    spawnCollect(
      "git",
      [
        "--no-optional-locks",
        "-C",
        repoPath,
        "status",
        "--porcelain=v1",
        "-b",
        "-z",
        "--untracked-files=normal",
      ],
      { env, timeoutMs: GIT_STATUS_LIMITS.gitTimeoutMs, maxBytes },
    ),
    spawnCollect(
      "git",
      ["--no-optional-locks", "-C", repoPath, "log", "-1", "--format=%h%x09%s"],
      { env, timeoutMs: GIT_STATUS_LIMITS.gitTimeoutMs, maxBytes: 8_000 },
    ),
  ]);

  if (status.code !== 0 || status.timedOut) {
    const row = emptyRepo(repoPath, relPath, gitFailureMessage(status.stderr, status.code, status.timedOut));
    if (/no commits yet|does not have any commits/i.test(status.stderr)) row.noCommits = true;
    return row;
  }

  let stdout = status.stdout;
  const outputCut = stdout.length >= maxBytes;
  if (outputCut) {
    const lastNul = stdout.lastIndexOf("\0");
    stdout = lastNul >= 0 ? stdout.slice(0, lastNul) : "";
  }
  const parsed = parseGitStatusPorcelainZ(stdout);
  const fileCount = parsed.files.length;
  const files = parsed.files.slice(0, maxFiles);
  let head: string | null = null;
  let subject: string | null = null;
  if (log.code === 0 && !log.timedOut) {
    const line = log.stdout.split("\n")[0] ?? "";
    const tab = line.indexOf("\t");
    if (tab > 0) {
      head = line.slice(0, tab).trim() || null;
      subject = line.slice(tab + 1).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200) || null;
    }
  }
  return {
    path: repoPath,
    relPath,
    branch: parsed.branch.branch,
    detached: parsed.branch.detached,
    upstream: parsed.branch.upstream,
    ahead: parsed.branch.ahead,
    behind: parsed.branch.behind,
    upstreamGone: parsed.branch.upstreamGone,
    dirty: fileCount > 0,
    head,
    subject,
    noCommits: parsed.branch.noCommits,
    files,
    fileCount,
    filesTruncated: outputCut || fileCount > maxFiles,
    error: null,
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        out[index] = await fn(item);
      }
    }),
  );
  return out;
}

async function computeWorkspaceGitStatus(
  root: string,
  limits: LimitOverrides,
): Promise<GitWorkspaceStatus> {
  const discovered = await discoverGitRepos(root, limits);
  const repos = await mapPool(discovered.repos, GIT_STATUS_LIMITS.concurrency, async (repoPath) => {
    try {
      return await readRepoStatus(discovered.root, repoPath, discovered.caps.maxFilesPerRepo);
    } catch (err) {
      const relPath = relOf(discovered.root, repoPath) ?? ".";
      return emptyRepo(
        repoPath,
        relPath,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
  repos.sort((a, b) => {
    if (a.relPath === ".") return -1;
    if (b.relPath === ".") return 1;
    return a.relPath.localeCompare(b.relPath);
  });
  return {
    root: discovered.root,
    repos,
    truncated: discovered.truncated,
    scannedDirs: discovered.scannedDirs,
    caps: discovered.caps,
    cached: false,
  };
}

/**
 * Read-only git status for every repository under `root`.
 * Results are cached briefly and concurrent callers share one in-flight probe.
 * `refresh` bypasses the cache.
 */
export async function workspaceGitStatus(
  rootInput: string,
  opts: { refresh?: boolean; limits?: LimitOverrides } = {},
): Promise<GitWorkspaceStatus> {
  let rootStat: string;
  try {
    rootStat = await realpath(rootInput);
    const st = await stat(rootStat);
    if (!st.isDirectory()) throw new HttpError(400, "path is not a directory");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "path not found");
  }

  const key = `${rootStat}\0${opts.limits?.maxDepth ?? ""}\0${opts.limits?.maxRepos ?? ""}\0${opts.limits?.maxDirs ?? ""}\0${opts.limits?.maxFilesPerRepo ?? ""}`;
  if (!opts.refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < GIT_STATUS_LIMITS.cacheTtlMs) {
      return { ...hit.value, cached: true };
    }
    const pending = inflight.get(key);
    if (pending) {
      const shared = await pending;
      return { ...shared, cached: true };
    }
  }

  const job = computeWorkspaceGitStatus(rootStat, opts.limits ?? {}).then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
  const tracked = job.finally(() => {
    if (inflight.get(key) === tracked) inflight.delete(key);
  });
  inflight.set(key, tracked);
  return tracked;
}
