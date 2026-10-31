import { publish } from "./bus.js";
import { HttpError } from "./httpError.js";
import { assertTextLimit, MAX_PROMPT_CHARS, MAX_TITLE_CHARS } from "./limits.js";
import { resolveAllowedDirectory } from "./paths.js";
import { getWorkspace, upsertWorkspace } from "./store.js";
import type { Workspace, WorkspaceSettings } from "./types.js";
import { normalizeWorkspaceSettings } from "./workspaceApply.js";

/**
 * Same replacement rules as `PATCH /api/workspaces/:id`.
 * Omitted `name` / `path` keep the stored values. A present `settings` object
 * replaces the stored object (empty strings clear those keys). Omitted `settings`
 * keeps it. Existing tasks are not rewritten; `task.cwd` stays where it was.
 */
export async function applyWorkspacePatch(id: string, body: Record<string, unknown>): Promise<Workspace> {
  const cur = getWorkspace(id);
  if (!cur) throw new HttpError(404, "not found");
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : cur.name;
  if (body.name != null && typeof body.name !== "string") {
    throw new HttpError(400, "name must be a string");
  }
  const rawPath = typeof body.path === "string" && body.path.trim() ? body.path.trim() : cur.path;
  if (body.path != null && typeof body.path !== "string") {
    throw new HttpError(400, "path must be a string");
  }
  const path = resolveAllowedDirectory(rawPath, "path");
  if (typeof name === "string") assertTextLimit(name, MAX_TITLE_CHARS, "name");
  const settings = "settings" in body ? normalizeWorkspaceSettings(body.settings) : cur.settings;
  assertWorkspaceSettingsSize(settings);
  const ws: Workspace = {
    ...cur,
    name,
    path,
    settings,
    updatedAt: new Date().toISOString(),
  };
  await upsertWorkspace(ws);
  publish({ type: "workspace_upsert", workspace: ws });
  return ws;
}

export function assertWorkspaceSettingsSize(settings: WorkspaceSettings | undefined): void {
  if (!settings) return;
  if (settings.systemPrompt) assertTextLimit(settings.systemPrompt, MAX_PROMPT_CHARS, "systemPrompt");
  if (settings.mcp) assertTextLimit(settings.mcp, MAX_PROMPT_CHARS, "mcp");
  for (const skill of settings.skills || []) {
    assertTextLimit(skill, 2_000, "skills");
  }
}
