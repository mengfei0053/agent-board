import type { Workspace, WorkspaceSettings } from "../types.js";

export type PhoneGitSummary = {
  branch: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  detached: boolean;
  repoCount: number;
  error: string | null;
};

export type PhoneWorkspaceSettings = {
  systemPrompt: string;
  skills: string[];
  mcp: string;
};

/** Ack body for `cmd.workspace.get` and `cmd.workspace.update`. */
export type PhoneWorkspaceCard = {
  id: string;
  name: string;
  path: string;
  isGit: boolean;
  settings: PhoneWorkspaceSettings;
  git: PhoneGitSummary;
};

type GitRepoLike = {
  relPath: string;
  branch: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  detached: boolean;
  error: string | null;
};

export function emptyGitSummary(error: string | null): PhoneGitSummary {
  return {
    branch: null,
    dirty: false,
    ahead: null,
    behind: null,
    detached: false,
    repoCount: 0,
    error,
  };
}

/** Root repository (`relPath === "."`), otherwise the first repo. No file list. */
export function summarizeWorkspaceGit(
  status: { repos: GitRepoLike[] } | null,
  failure: string | null = null,
): PhoneGitSummary {
  if (!status) return emptyGitSummary(failure ?? "git status failed");
  const root = status.repos.find((repo) => repo.relPath === ".") ?? status.repos[0];
  if (!root) return emptyGitSummary(null);
  return {
    branch: root.branch,
    dirty: root.dirty,
    ahead: root.ahead,
    behind: root.behind,
    detached: root.detached,
    repoCount: status.repos.length,
    error: clipGitError(root.error),
  };
}

export function wireWorkspaceCard(
  ws: Pick<Workspace, "id" | "name" | "path" | "settings">,
  isGit: boolean,
  git: PhoneGitSummary,
): PhoneWorkspaceCard {
  return {
    id: ws.id,
    name: ws.name,
    path: ws.path,
    isGit,
    settings: wireSettings(ws.settings),
    git,
  };
}

export function wireSettings(settings: WorkspaceSettings | undefined): PhoneWorkspaceSettings {
  return {
    systemPrompt: settings?.systemPrompt ?? "",
    skills: settings?.skills ? [...settings.skills] : [],
    mcp: settings?.mcp ?? "",
  };
}

function clipGitError(error: string | null): string | null {
  if (!error) return null;
  const flat = error.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\/\S*/g, "").trim();
  if (!flat) return "git status failed";
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}
