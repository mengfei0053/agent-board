import type { Task } from "../types.js";
import { mapBoardTask, wireMappedTask, type MappedTask } from "./map.js";

export const ARCHIVE_PAGE_DEFAULT = 20;
export const ARCHIVE_PAGE_MAX = 50;
const ARCHIVE_CURSOR = /^([0-9]{1,16}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

export type ArchivePage = {
  tasks: MappedTask[];
  nextCursor?: string;
};

/**
 * Newest `updatedAt` first. Equal timestamps break ties by id ascending.
 * The cursor is the last row of the previous page (`updatedAt:id`).
 * Archived rows stay out of the hot snapshot; this page is the only list of them.
 */
export function pageArchivedTasks(tasks: Task[], cursor: string | undefined, limit: number):
  { ok: true; page: ArchivePage } | { ok: false; message: string } {
  if (!Number.isInteger(limit) || limit < 1 || limit > ARCHIVE_PAGE_MAX) {
    return { ok: false, message: "limit is invalid" };
  }
  if (cursor !== undefined && !ARCHIVE_CURSOR.test(cursor)) {
    return { ok: false, message: "cursor is invalid" };
  }
  const rows = tasks.flatMap((task) => {
    const mapped = mapBoardTask(task, true);
    return mapped?.status === "archived" ? [mapped] : [];
  });
  rows.sort(compareArchive);
  let start = 0;
  if (cursor) {
    const split = cursor.indexOf(":");
    const at = Number(cursor.slice(0, split));
    const id = cursor.slice(split + 1);
    const idx = rows.findIndex((row) => row.updatedAt < at || (row.updatedAt === at && row.id > id));
    start = idx < 0 ? rows.length : idx;
  }
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  const more = start + page.length < rows.length;
  return {
    ok: true,
    page: {
      tasks: page,
      ...(more && last ? { nextCursor: `${last.updatedAt}:${last.id}` } : {}),
    },
  };
}

export function wireArchivePage(page: ArchivePage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tasks: page.tasks.map((task) => wireMappedTask(task, "snapshot")),
  };
  if (page.nextCursor) body.nextCursor = page.nextCursor;
  return body;
}

function compareArchive(a: MappedTask, b: MappedTask): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
