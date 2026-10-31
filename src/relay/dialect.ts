import type { BoardEvent } from "../types.js";
import { RelayCursor, type RelayFrame } from "./cursor.js";
import { mapBoardTask } from "./map.js";

export type DialectResult = {
  frames: RelayFrame[];
  needsSnapshot: boolean;
};

/**
 * Map one in-process board event onto relay frames.
 * `task_delete` and workspace changes ask for a fresh snapshot.
 * Archived (and any unmapped status) is dropped: no `evt.task` and no done.
 * `task_log` has no stream on the bus, so logs are marked `system`.
 */
export function eventsFromBoardEvent(
  cursor: RelayCursor,
  ev: BoardEvent,
  boardId: string,
): DialectResult {
  switch (ev.type) {
    case "task_upsert": {
      const mapped = mapBoardTask(ev.task);
      if (!mapped) {
        cursor.forget(ev.task.id);
        return { frames: [], needsSnapshot: false };
      }
      return { frames: cursor.observeTask(boardId, mapped), needsSnapshot: false };
    }
    case "task_log": {
      const frame = cursor.observeLog(boardId, ev.taskId, ev.line);
      return { frames: frame ? [frame] : [], needsSnapshot: false };
    }
    case "task_delete":
    case "workspace_upsert":
    case "workspace_delete":
      return { frames: [], needsSnapshot: true };
    case "hello":
      return { frames: [], needsSnapshot: false };
    default:
      return { frames: [], needsSnapshot: false };
  }
}
