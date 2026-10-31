import type { Task } from "../types.js";
import { mapBoardTask, wireMappedTask, type MappedTask } from "./map.js";

export const ARCHIVE_PAGE_DEFAULT = 20;
export const ARCHIVE_PAGE_MAX = 50;
/** `updatedAt:id` or `updatedAt:id:revision` (8 hex chars). Same shape as the public relay. */
export const ARCHIVE_CURSOR = /^([0-9]{1,16}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?::([a-f0-9]{8}))?$/;

export function isArchiveCursor(value: string): boolean {
  return ARCHIVE_CURSOR.test(value);
}

export type ArchivePage = {
  tasks: MappedTask[];
  nextCursor?: string;
  /** The archive set changed since this cursor was issued. `tasks` is page 1 again. */
  restarted?: boolean;
};

/**
 * Newest `updatedAt` first. Equal timestamps break ties by id ascending.
 * The cursor is `updatedAt:id:revision`. `revision` fingerprints the archived
 * id and updatedAt set, plus the workspace scope. A scoped page is filtered
 * before the limit and the cursor, so a cursor from another workspace restarts
 * instead of skipping rows. If the set changes, the next page restarts at the top.
 */
export function pageArchivedTasks(
  tasks: Task[],
  cursor: string | undefined,
  limit: number,
  workspaceId?: string,
): { ok: true; page: ArchivePage } | { ok: false; message: string } {
  if (!Number.isInteger(limit) || limit < 1 || limit > ARCHIVE_PAGE_MAX) {
    return { ok: false, message: "limit is invalid" };
  }
  const parsed = cursor === undefined ? null : parseArchiveCursor(cursor);
  if (cursor !== undefined && !parsed) return { ok: false, message: "cursor is invalid" };
  const scoped = workspaceId ? tasks.filter((task) => task.workspaceId === workspaceId) : tasks;
  const rows = scoped.flatMap((task) => {
    const mapped = mapBoardTask(task, true);
    return mapped?.status === "archived" ? [mapped] : [];
  });
  rows.sort(compareArchive);
  const revision = archiveRevision(rows, workspaceId ?? "");
  const restarted = parsed != null && parsed.revision !== revision;
  let start = 0;
  if (parsed && !restarted) {
    const idx = rows.findIndex((row) => row.updatedAt < parsed.at || (row.updatedAt === parsed.at && row.id > parsed.id));
    start = idx < 0 ? rows.length : idx;
  }
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  const more = start + page.length < rows.length;
  return {
    ok: true,
    page: {
      tasks: page,
      ...(more && last ? { nextCursor: `${last.updatedAt}:${last.id}:${revision}` } : {}),
      ...(restarted ? { restarted: true } : {}),
    },
  };
}

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

export function wireArchivePage(page: ArchivePage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tasks: page.tasks.map((task) => wireMappedTask(task, "snapshot")),
  };
  if (page.nextCursor) body.nextCursor = page.nextCursor;
  if (page.restarted) body.restarted = true;
  return body;
}

function parseArchiveCursor(cursor: string): { at: number; id: string; revision?: string } | null {
  const match = ARCHIVE_CURSOR.exec(cursor);
  if (!match) return null;
  return { at: Number(match[1]), id: match[2] ?? "", ...(match[3] ? { revision: match[3] } : {}) };
}

function compareArchive(a: MappedTask, b: MappedTask): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
