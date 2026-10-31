import { randomUUID } from "node:crypto";
import { isTerminalStatus, taskPayload, type MappedTask } from "./map.js";
import type { ThinWorkspace } from "./workspaces.js";

export type Outbound = {
  v: 1;
  id: string;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
};

/**
 * Sequence cursor for one relay generation.
 * evt.task.done fires only the first time a task enters succeeded, failed, or stopped.
 * Tasks already terminal in the post-register snapshot are recorded and not notified again.
 */
export class EventCursor {
  generation = 0;
  private seq = 0;
  private readonly terminal = new Set<string>();
  /** Last emitted title, status, and agent. updatedAt alone does not count as a change. */
  private readonly signature = new Map<string, string>();

  constructor(private readonly boardId: string) {}

  reset(generation: number): void {
    this.generation = generation;
    this.seq = 0;
    this.terminal.clear();
    this.signature.clear();
  }

  snapshot(tasks: MappedTask[], now = Date.now(), workspaces: ThinWorkspace[] = []): Outbound {
    for (const task of tasks) {
      this.signature.set(task.id, taskSignature(task));
      if (isTerminalStatus(task.status)) this.terminal.add(task.id);
    }
    const event = this.frame("evt.snapshot", {
      capturedAt: now,
      tasks: tasks.map(taskPayload),
      workspaces: workspaces.map(workspacePayload),
    });
    event.payload.version = event.payload.seq;
    return event;
  }

  /**
   * Emits evt.task when title, status, or agent changes.
   * evt.task.done is only the first entry into succeeded, failed, or stopped.
   */
  observe(task: MappedTask, now = Date.now()): Outbound[] {
    const next = taskSignature(task);
    const previous = this.signature.get(task.id);
    this.signature.set(task.id, next);
    if (previous === next) return [];
    const events = [this.frame("evt.task", { task: taskPayload(task) }, now)];
    if (isTerminalStatus(task.status) && !this.terminal.has(task.id)) {
      this.terminal.add(task.id);
      events.push(this.frame("evt.task.done", {
        taskId: task.id,
        status: task.status,
        title: task.title,
        summary: `Task ${task.status}`,
      }, now));
    }
    return events;
  }

  log(taskId: string, stream: "stdout" | "stderr" | "system", line: string, now = Date.now()): Outbound | null {
    if (!line) return null;
    return this.frame("evt.log", { taskId, stream, line }, now);
  }

  private frame(type: string, fields: Record<string, unknown>, now = Date.now()): Outbound {
    this.seq += 1;
    return {
      v: 1,
      id: randomUUID(),
      type,
      ts: now,
      payload: {
        boardId: this.boardId,
        generation: this.generation,
        seq: this.seq,
        eventId: randomUUID(),
        ...fields,
      },
    };
  }
}

function taskSignature(task: MappedTask): string {
  return `${task.title}\0${task.status}\0${task.agent ?? ""}`;
}

function workspacePayload(workspace: ThinWorkspace): Record<string, string | boolean> {
  return { id: workspace.id, name: workspace.name, path: workspace.path, isGit: workspace.isGit };
}
