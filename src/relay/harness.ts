import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { BoardEvent, Task, Workspace } from "../types.js";
import type { EnabledRelayConfig } from "./config.js";
import { RelayCommandError } from "./errors.js";
import type { BoardFacade, FacadeCreateInput, FacadeWorkspaceInput } from "./facade.js";

export type ClientFrame = {
  v: number;
  id: string;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
};

export function enabledConfig(url: string, extra: Partial<EnabledRelayConfig> = {}): EnabledRelayConfig {
  return {
    enabled: true,
    relayWsUrl: url,
    boardId: "thinkbook",
    boardToken: "test-board-token",
    boardLabel: "ThinkBook",
    reconnectMinMs: 40,
    reconnectMaxMs: 5_000,
    openTimeoutMs: 1_000,
    registerTimeoutMs: 1_000,
    ...extra,
  };
}

export function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Ship",
    kind: "pi",
    workspaceId: "w1",
    cwd: "/tmp/repo",
    prompt: "do the thing",
    iteration: 1,
    status: "running",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    summary: "working",
    ...partial,
  };
}

export function makeWorkspace(partial: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    name: "repo",
    path: "/tmp/repo",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    ...partial,
  };
}

export type MemoryFacade = BoardFacade & {
  tasks: Task[];
  workspaces: Workspace[];
  listeners: Set<(ev: BoardEvent) => void>;
  creates: number;
  createImpl: (input: FacadeCreateInput) => Promise<Task>;
  publish(ev: BoardEvent): void;
};

export function memoryFacade(seed?: { tasks?: Task[]; workspaces?: Workspace[] }): MemoryFacade {
  const tasks = [...(seed?.tasks ?? [])];
  const workspaces = [...(seed?.workspaces ?? [])];
  const listeners = new Set<(ev: BoardEvent) => void>();
  const facade = {
    tasks,
    workspaces,
    listeners,
    creates: 0,
    createImpl: async (input: FacadeCreateInput) => {
      facade.creates += 1;
      const task = makeTask({
        id: `t${facade.creates}`,
        title: input.title,
        kind: input.kind,
        cwd: input.cwd,
        prompt: input.prompt,
        status: "queued",
        summary: undefined,
      });
      tasks.push(task);
      return task;
    },
    publish(ev: BoardEvent) {
      if (ev.type === "task_upsert") {
        const idx = tasks.findIndex((task) => task.id === ev.task.id);
        if (idx >= 0) tasks[idx] = ev.task;
        else tasks.push(ev.task);
      } else if (ev.type === "task_delete") {
        for (const id of ev.taskIds) {
          const idx = tasks.findIndex((task) => task.id === id);
          if (idx >= 0) tasks.splice(idx, 1);
        }
      }
      for (const fn of listeners) fn(ev);
    },
    boardSnapshot: () => tasks.map((task) => ({ ...task })),
    workspaceSnapshot: () => workspaces.map((workspace) => ({ ...workspace })),
    gitEligibility: async () => ({ ok: true }),
    create: (input: FacadeCreateInput) => facade.createImpl(input),
    stop: async (id: string) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) {
        const err = new Error("not found");
        throw err;
      }
      task.status = "stopped";
      return { ...task };
    },
    continue: async (id: string) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) throw new Error("not found");
      task.status = "running";
      return { ...task };
    },
    createWorkspace: async (input: FacadeWorkspaceInput) => {
      const name = input.name.trim();
      if (!name) throw new RelayCommandError("bad_request", "name is required");
      const path = input.path.trim();
      if (!path) throw new RelayCommandError("bad_request", "path is required");
      const ws: Workspace = {
        id: `ws${workspaces.length + 1}`,
        name,
        path,
        createdAt: "2026-10-31T00:00:00.000Z",
        updatedAt: "2026-10-31T00:00:00.000Z",
      };
      workspaces.push(ws);
      facade.publish({ type: "workspace_upsert", workspace: { ...ws } });
      return ws;
    },
    deleteWorkspace: async (id: string) => {
      const index = workspaces.findIndex((workspace) => workspace.id === id);
      if (index < 0) throw new RelayCommandError("not_found", "workspace not found");
      if (index === 0) throw new RelayCommandError("bad_request", "cannot delete the default workspace");
      if (tasks.some((task) => task.workspaceId === id)) {
        throw new RelayCommandError("bad_request", "workspace still has tasks; move or delete them first");
      }
      workspaces.splice(index, 1);
      facade.publish({ type: "workspace_delete", workspaceIds: [id] });
    },
    subscribe(fn: (ev: BoardEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return facade;
}

export class MockRelay {
  port = 0;
  received: ClientFrame[] = [];
  /** Frames this mock sent to the board, including register ack and err. */
  sent: ClientFrame[] = [];
  clients: WebSocket[] = [];
  /** Next register ack generation. Incremented after each ack. */
  generation = 1;
  silent = false;
  rejectCode: string | null = null;
  /** Invoked after a register frame is stored and before the ack, unless silent or rejecting. */
  beforeAck: ((ws: WebSocket, registerId: string) => void) | null = null;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;

  async listen(): Promise<void> {
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/v1/ws" });
    wss.on("connection", (ws) => {
      this.clients.push(ws);
      ws.on("message", (data) => {
        let msg: ClientFrame;
        try {
          msg = JSON.parse(String(data)) as ClientFrame;
        } catch {
          return;
        }
        this.received.push(msg);
        if (msg.type !== "board.register") return;
        if (this.silent || this.rejectCode) {
          if (this.rejectCode) {
            this.send(
              ws,
              "err",
              { code: this.rejectCode, message: "board token rejected", ref: msg.id },
              randomUUID(),
            );
            ws.close();
          }
          return;
        }
        this.beforeAck?.(ws, msg.id);
        const generation = this.generation;
        this.generation += 1;
        this.send(ws, "ack", { stage: "executed", generation, ref: msg.id }, randomUUID());
      });
      ws.on("close", () => {
        this.clients = this.clients.filter((client) => client !== ws);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    this.port = address.port;
    this.server = server;
    this.wss = wss;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/v1/ws`;
  }

  send(ws: WebSocket, type: string, payload: Record<string, unknown>, id = `m${Date.now()}`): void {
    const frame: ClientFrame = { v: 1, id, type, ts: Date.now(), payload };
    this.sent.push(frame);
    ws.send(JSON.stringify(frame));
  }

  drop(): void {
    for (const client of [...this.clients]) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for relay condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
