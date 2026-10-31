import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type MockRequest = { method: string; path: string; body: unknown };

export type MockBoard = {
  url: string;
  requests: MockRequest[];
  failCreates: number;
  listDelayMs: number;
  listGate: Promise<void> | null;
  seed: (task: { id: string; title: string; status: string; updatedAt: number; kind?: string }) => void;
  seedWorkspace: (workspace: { id: string; name: string; path: string; isGit: boolean }) => void;
  emit: (event: string, data: Record<string, unknown>) => void;
  close: () => Promise<void>;
};

type Task = {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  kind?: string;
  prompt?: string;
  cwd?: string;
};

export async function startMockBoard(): Promise<MockBoard> {
  const tasks = new Map<string, Task>();
  const workspaces = new Map<string, { id: string; name: string; path: string; isGit: boolean }>();
  const requests: MockRequest[] = [];
  const streams = new Set<ServerResponse>();
  let failCreates = 0;
  let listDelayMs = 0;
  let listGate: Promise<void> | null = null;
  let sequence = 1;

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/events") {
      req.resume();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": open\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      requests.push({ method: "GET", path: url.pathname, body: undefined });
      return;
    }
    const body = await readBody(req);
    requests.push({ method: req.method ?? "GET", path: url.pathname, body });
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      if (listDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, listDelayMs));
      if (listGate) await listGate;
      json(res, 200, { tasks: [...tasks.values()] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      json(res, 200, { workspaces: [...workspaces.values()].map(({ id, name, path }) => ({ id, name, path })) });
      return;
    }
    const eligibility = /^\/api\/workspaces\/([^/]+)\/git-worktree-eligibility$/.exec(url.pathname);
    if (req.method === "GET" && eligibility) {
      const id = decodeURIComponent(eligibility[1] ?? "");
      const row = workspaces.get(id);
      if (!row) {
        json(res, 404, { ok: false, reason: "not found" });
        return;
      }
      json(res, 200, row.isGit ? { ok: true, root: row.path, head: "abc" } : { ok: false, reason: "not a git repository" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/tasks") {
      if (failCreates > 0) {
        failCreates -= 1;
        json(res, 503, { error: "unavailable" });
        return;
      }
      const input = isRecord(body) ? body : {};
      const task: Task = {
        id: `task_${sequence++}`,
        title: typeof input.title === "string" ? input.title : "untitled",
        status: "queued",
        updatedAt: Date.now(),
        kind: typeof input.kind === "string" ? input.kind : undefined,
        prompt: typeof input.prompt === "string" ? input.prompt : undefined,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      };
      tasks.set(task.id, task);
      json(res, 200, task);
      return;
    }
    const stop = /^\/api\/tasks\/([^/]+)\/stop$/.exec(url.pathname);
    const cont = /^\/api\/tasks\/([^/]+)\/continue$/.exec(url.pathname);
    const one = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    const id = decodeURIComponent((stop ?? cont ?? one)?.[1] ?? "");
    const task = tasks.get(id);
    if (!task) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "POST" && stop) task.status = "stopped";
    if (req.method === "POST" && cont) task.status = "running";
    task.updatedAt = Date.now();
    json(res, 200, task);
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock board did not bind");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get failCreates() {
      return failCreates;
    },
    set failCreates(value: number) {
      failCreates = value;
    },
    get listDelayMs() {
      return listDelayMs;
    },
    set listDelayMs(value: number) {
      listDelayMs = value;
    },
    get listGate() {
      return listGate;
    },
    set listGate(value: Promise<void> | null) {
      listGate = value;
    },
    seed: (task) => {
      tasks.set(task.id, task);
    },
    seedWorkspace: (workspace) => {
      workspaces.set(workspace.id, workspace);
    },
    emit: (event, data) => {
      if (event === "task" && typeof data.id === "string") {
        const existing = tasks.get(data.id);
        if (existing && typeof data.status === "string") existing.status = data.status;
      }
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const stream of streams) stream.write(frame);
    },
    close: () => new Promise((resolve) => {
      for (const stream of streams) stream.end();
      server.close(() => resolve());
    }),
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
