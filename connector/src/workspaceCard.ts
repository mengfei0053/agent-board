/** Phone workspace card. Keep the field set in lockstep with `src/relay/workspaceCard.ts`. */

export type PhoneWorkspaceCard = {
  id: string;
  name: string;
  path: string;
  isGit: boolean;
  settings: { systemPrompt: string; skills: string[]; mcp: string };
  git: {
    branch: string | null;
    dirty: boolean;
    ahead: number | null;
    behind: number | null;
    detached: boolean;
    repoCount: number;
    error: string | null;
  };
};

export function phoneWorkspaceCard(workspace: unknown, isGit: boolean, gitStatus: unknown, gitFailed: boolean): PhoneWorkspaceCard | null {
  const ws = unwrapWorkspace(workspace);
  if (!ws) return null;
  const id = typeof ws.id === "string" ? ws.id : "";
  const name = typeof ws.name === "string" ? ws.name : "";
  const path = typeof ws.path === "string" ? ws.path : "";
  if (!id || !name || !path) return null;
  const settings = isRecord(ws.settings) ? ws.settings : {};
  const skills = Array.isArray(settings.skills)
    ? settings.skills.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id,
    name,
    path,
    isGit,
    settings: {
      systemPrompt: typeof settings.systemPrompt === "string" ? settings.systemPrompt : "",
      skills,
      mcp: typeof settings.mcp === "string" ? settings.mcp : "",
    },
    git: summarize(gitStatus, gitFailed),
  };
}

function unwrapWorkspace(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.workspace)) return value.workspace;
  return value;
}

function summarize(status: unknown, failed: boolean): PhoneWorkspaceCard["git"] {
  const empty = {
    branch: null,
    dirty: false,
    ahead: null,
    behind: null,
    detached: false,
    repoCount: 0,
    error: failed ? "git status failed" : null,
  };
  if (failed || !isRecord(status) || !Array.isArray(status.repos)) return empty;
  const repos = status.repos.filter(isRecord);
  const root = repos.find((repo) => repo.relPath === ".") ?? repos[0];
  if (!root) return empty;
  return {
    branch: typeof root.branch === "string" ? root.branch : null,
    dirty: root.dirty === true,
    ahead: typeof root.ahead === "number" ? root.ahead : null,
    behind: typeof root.behind === "number" ? root.behind : null,
    detached: root.detached === true,
    repoCount: repos.length,
    error: typeof root.error === "string" && root.error && !/[\\/@]|:\/\//.test(root.error) ? root.error.slice(0, 180) : root.error ? "git status failed" : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
