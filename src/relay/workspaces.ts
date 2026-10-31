import { RELAY_LIMITS } from "./limits.js";
import type { Workspace } from "../types.js";

export type ThinWorkspace = {
  id: string;
  name: string;
  path: string;
  isGit: boolean;
};

export type GitEligibility = { ok: boolean };

/**
 * Build the thin workspace list for `evt.snapshot`.
 * A failed refresh demotes `isGit` to false. A prior `true` is not kept.
 */
export async function enrichWorkspaces(
  workspaces: readonly Workspace[],
  eligibility: (path: string) => Promise<GitEligibility>,
): Promise<ThinWorkspace[]> {
  const slice = workspaces.slice(0, RELAY_LIMITS.maxWorkspaces);
  const out: ThinWorkspace[] = [];
  for (const workspace of slice) {
    if (!workspace.id || !workspace.name || !workspace.path) continue;
    if (workspace.path.includes("://")) continue;
    let isGit = false;
    try {
      const result = await eligibility(workspace.path);
      isGit = result.ok === true;
    } catch {
      isGit = false;
    }
    out.push({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      isGit,
    });
  }
  return out;
}
