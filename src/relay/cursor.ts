import { randomUUID } from "node:crypto";
import { RELAY_LIMITS } from "./limits.js";
import {
  isTerminalStatus,
  taskSignature,
  type MappedTask,
} from "./map.js";
import type { ThinWorkspace } from "./workspaces.js";

export type RelayFrame = {
  type: string;
  payload: Record<string, unknown>;
};

/**
 * Per-generation cursor. A new register ack builds a new cursor so terminal
 * tasks in the fresh snapshot do not replay `evt.task.done`.
 */
export class RelayCursor {
  seq = 0;
  private known = new Map<string, string>();
  private done = new Set<string>();

  constructor(readonly generation: number) {}

  forget(taskId: string): boolean {
    const had = this.known.delete(taskId);
    this.done.delete(taskId);
    return had;
  }

  /** Generation baseline. Terminal tasks here are already done and must not notify again. */
  buildSnapshot(boardId: string, tasks: MappedTask[], workspaces: ThinWorkspace[]): RelayFrame {
    const capped = capTasks(tasks);
    this.known.clear();
    this.done.clear();
    for (const task of capped) {
      this.known.set(task.id, taskSignature(task));
      if (isTerminalStatus(task.status)) this.done.add(task.id);
    }
    return this.snapshotFrame(boardId, capped, workspaces);
  }

  /**
   * Snapshot after delete or a workspace change. Does not adopt store state
   * that later buffered events still have to announce: known signatures and
   * the done set stay, except ids the board no longer has.
   */
  refreshSnapshot(boardId: string, tasks: MappedTask[], workspaces: ThinWorkspace[]): RelayFrame {
    const present = new Set(tasks.map((task) => task.id));
    for (const id of [...this.known.keys()]) {
      if (!present.has(id)) {
        this.known.delete(id);
        this.done.delete(id);
      }
    }
    return this.snapshotFrame(boardId, capTasks(tasks), workspaces);
  }

  private snapshotFrame(boardId: string, tasks: MappedTask[], workspaces: ThinWorkspace[]): RelayFrame {
    return this.event("evt.snapshot", {
      boardId,
      capturedAt: Date.now(),
      tasks: tasks.map(wireTask),
      workspaces,
    });
  }

  /**
   * Emit `evt.task` when title, status, or agent changes.
   * Emit `evt.task.done` once per task per terminal entry in this generation.
   */
  observeTask(boardId: string, task: MappedTask): RelayFrame[] {
    const sig = taskSignature(task);
    const prev = this.known.get(task.id);
    const frames: RelayFrame[] = [];
    if (prev !== sig) {
      this.known.set(task.id, sig);
      frames.push(this.event("evt.task", { boardId, task: wireTask(task) }));
    }
    if (!isTerminalStatus(task.status)) {
      this.done.delete(task.id);
      return frames;
    }
    if (!this.done.has(task.id)) {
      this.done.add(task.id);
      frames.push(this.event("evt.task.done", {
        boardId,
        eventId: `done-${this.generation}-${task.id}`,
        taskId: task.id,
        status: task.status,
        title: task.title,
        ...(task.summary ? { summary: task.summary } : {}),
      }));
    }
    return frames;
  }

  observeLog(boardId: string, taskId: string, line: string): RelayFrame | null {
    const trimmed = truncateLog(line);
    if (!trimmed) return null;
    const seqFrame = this.event("evt.log", {
      boardId,
      eventId: "",
      taskId,
      line: trimmed,
      stream: "system",
    });
    seqFrame.payload.eventId = `log-${this.generation}-${String(seqFrame.payload.seq)}`;
    return seqFrame;
  }

  private event(type: string, payload: Record<string, unknown>): RelayFrame {
    this.seq += 1;
    return {
      type,
      payload: {
        ...payload,
        generation: this.generation,
        seq: this.seq,
        version: this.seq,
        eventId: typeof payload.eventId === "string" && payload.eventId
          ? payload.eventId
          : randomUUID(),
      },
    };
  }
}

function wireTask(task: MappedTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
  };
}

function capTasks(tasks: MappedTask[]): MappedTask[] {
  if (tasks.length <= RELAY_LIMITS.maxSnapshotTasks) return tasks;
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RELAY_LIMITS.maxSnapshotTasks);
}

function truncateLog(line: string): string {
  const flat = line.replace(/\r/g, "");
  if (!flat.trim()) return "";
  if (flat.length <= RELAY_LIMITS.maxLogChars) return flat;
  return `${flat.slice(0, RELAY_LIMITS.maxLogChars)}…`;
}
