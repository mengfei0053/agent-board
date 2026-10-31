const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARCHIVE_CURSOR = /^([0-9]{1,16}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?::([a-f0-9]{8}))?$/;

export type ArchiveRow = {
  id: string;
  title: string;
  status: "archived";
  updatedAt: number;
  agent?: string;
  workspaceId?: string;
  cwd?: string;
  prompt?: string;
  promptPreview?: string;
};

export function mapArchiveRow(raw: unknown, full: boolean): ArchiveRow | null {
  if (!isRecord(raw)) return null;
  if (raw.status !== "archived") return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!TASK_ID.test(id)) return null;
  const title = clean(typeof raw.title === "string" ? raw.title : "untitled", 200) || "untitled";
  const updatedAt = readTime(raw.updatedAt);
  const row: ArchiveRow = { id, title, status: "archived", updatedAt };
  const agent = typeof raw.kind === "string" ? raw.kind : typeof raw.agent === "string" ? raw.agent : "";
  if (agent && agent.length <= 64) row.agent = agent;
  const workspaceId = typeof raw.workspaceId === "string" ? raw.workspaceId : "";
  if (workspaceId && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(workspaceId)) row.workspaceId = workspaceId;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  if (cwd && cwd.length <= 1024 && !cwd.includes("://")) row.cwd = cwd;
  const prompt = typeof raw.prompt === "string" ? clean(raw.prompt, full ? 2_000 : 240) : "";
  if (prompt) {
    if (full) row.prompt = prompt;
    else row.promptPreview = prompt;
  }
  return row;
}

export function pageArchiveRows(
  rows: ArchiveRow[],
  cursor: string | undefined,
  limit: number,
  workspaceId?: string,
): { ok: true; tasks: ArchiveRow[]; nextCursor?: string; restarted?: boolean } | { ok: false; message: string } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return { ok: false, message: "limit is invalid" };
  const parsed = cursor === undefined ? null : parseArchiveCursor(cursor);
  if (cursor !== undefined && !parsed) return { ok: false, message: "cursor is invalid" };
  const scoped = workspaceId ? rows.filter((row) => row.workspaceId === workspaceId) : rows;
  const sorted = [...scoped].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const revision = archiveRevision(sorted, workspaceId ?? "");
  const restarted = parsed != null && parsed.revision !== revision;
  let start = 0;
  if (parsed && !restarted) {
    const idx = sorted.findIndex((row) => row.updatedAt < parsed.at || (row.updatedAt === parsed.at && row.id > parsed.id));
    start = idx < 0 ? sorted.length : idx;
  }
  const tasks = sorted.slice(start, start + limit);
  const last = tasks.at(-1);
  const more = start + tasks.length < sorted.length;
  return {
    ok: true,
    tasks,
    ...(more && last ? { nextCursor: `${last.updatedAt}:${last.id}:${revision}` } : {}),
    ...(restarted ? { restarted: true } : {}),
  };
}

/** Fingerprint of archived id + updatedAt. A changed set invalidates the cursor. */
export function archiveRevision(rows: { id: string; updatedAt: number }[], scope = ""): string {
  let hash = mix(2166136261, `scope=${scope}\n`);
  const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const row of ordered) {
    hash = mix(hash, `${row.id}=${row.updatedAt}\n`);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mix(hash: number, text: string): number {
  let next = hash;
  for (let i = 0; i < text.length; i += 1) {
    next ^= text.charCodeAt(i);
    next = Math.imul(next, 16777619);
  }
  return next;
}

function parseArchiveCursor(cursor: string): { at: number; id: string; revision?: string } | null {
  const match = ARCHIVE_CURSOR.exec(cursor);
  if (!match) return null;
  return { at: Number(match[1]), id: match[2] ?? "", ...(match[3] ? { revision: match[3] } : {}) };
}

export function wireArchiveRow(row: ArchiveRow, full: boolean): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    status: row.status,
    updatedAt: row.updatedAt,
  };
  if (row.agent) wire.agent = row.agent;
  if (row.workspaceId) wire.workspaceId = row.workspaceId;
  if (row.cwd) wire.cwd = row.cwd;
  if (full) {
    wire.detail = "full";
    if (row.prompt) wire.prompt = row.prompt;
  } else if (row.promptPreview) {
    wire.promptPreview = row.promptPreview;
  }
  return wire;
}

function readTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function clean(value: string, max: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
