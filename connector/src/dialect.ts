import type { EventCursor, Outbound } from "./cursor.js";
import { cleanLine, mapBoardTask, normalizeStream, type MappedTask } from "./map.js";
import type { ThinWorkspace } from "./workspaces.js";

/**
 * ThinkBook agent-board SSE (`GET /api/events`).
 * Event names are hello, task_upsert, task_delete, task_log, workspace_*, and ping.
 */
export function eventsFromBoardSse(
  cursor: EventCursor,
  known: Map<string, MappedTask>,
  eventName: string,
  data: string,
  workspaces: ThinWorkspace[] = [],
): Outbound[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const name = resolveName(eventName, parsed.type);
  if (name === "hello") {
    const tasks = readTasks(parsed.tasks);
    replaceKnown(known, tasks);
    return [cursor.snapshot(tasks, Date.now(), workspaces)];
  }
  if (name === "workspace_upsert" || name === "workspace_delete") {
    return [cursor.snapshot([...known.values()], Date.now(), workspaces)];
  }
  if (name === "task_upsert") {
    const task = mapBoardTask(parsed.task);
    if (!task) return [];
    known.set(task.id, task);
    return cursor.observe(task);
  }
  if (name === "task_log") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId : "";
    const line = typeof parsed.line === "string" ? cleanLine(parsed.line) : "";
    if (!taskId || !line) return [];
    const event = cursor.log(taskId, normalizeStream(parsed.stream), line);
    return event ? [event] : [];
  }
  if (name === "task_delete") {
    const ids = Array.isArray(parsed.taskIds) ? parsed.taskIds : [];
    for (const id of ids) {
      if (typeof id === "string") known.delete(id);
    }
    return [cursor.snapshot([...known.values()], Date.now(), workspaces)];
  }
  return [];
}

function resolveName(eventName: string, typeField: unknown): string {
  if (eventName !== "message") return eventName;
  return typeof typeField === "string" ? typeField : eventName;
}

function readTasks(value: unknown): MappedTask[] {
  if (!Array.isArray(value)) return [];
  return value.map(mapBoardTask).filter((task): task is MappedTask => task !== null);
}

function replaceKnown(known: Map<string, MappedTask>, tasks: MappedTask[]): void {
  known.clear();
  for (const task of tasks) known.set(task.id, task);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
