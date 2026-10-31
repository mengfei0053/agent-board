export type WorkspaceStub = {
  id: string;
  name: string;
  path: string;
};

export type ThinWorkspace = WorkspaceStub & {
  isGit: boolean;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A failed workspace refresh must not keep advertising the previous isGit bit. */
export function demoteWorkspaces(current: ThinWorkspace[]): ThinWorkspace[] {
  return current.map((row) => ({ ...row, isGit: false }));
}

export function stubsFromSseData(data: string): WorkspaceStub[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  if (Array.isArray(parsed.workspaces)) return readStubs(parsed.workspaces);
  if (isRecord(parsed.workspace)) return readStubs([parsed.workspace]);
  return [];
}

export function deletedWorkspaceIds(data: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const ids: string[] = [];
  if (Array.isArray(parsed.workspaceIds)) {
    for (const id of parsed.workspaceIds) {
      if (typeof id === "string" && ID.test(id)) ids.push(id);
    }
  }
  if (typeof parsed.workspaceId === "string" && ID.test(parsed.workspaceId)) ids.push(parsed.workspaceId);
  if (typeof parsed.id === "string" && ID.test(parsed.id) && parsed.path === undefined && parsed.workspace === undefined) {
    ids.push(parsed.id);
  }
  return ids;
}

export function sseKind(eventName: string, data: string): string {
  if (eventName !== "message") return eventName;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (isRecord(parsed) && typeof parsed.type === "string") return parsed.type;
  } catch {
    return eventName;
  }
  return eventName;
}

function readStubs(value: unknown[]): WorkspaceStub[] {
  const stubs: WorkspaceStub[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const path = typeof item.path === "string" ? item.path : "";
    if (!ID.test(id) || !name || name.length > 80) continue;
    if (!path || path.length > 1024 || path.includes("://") || /[\u0000-\u001f\u007f]/.test(path)) continue;
    stubs.push({ id, name, path });
    if (stubs.length >= 50) break;
  }
  return stubs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
