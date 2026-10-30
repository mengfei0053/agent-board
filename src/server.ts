import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { subscribe } from "./bus.js";
import {
  boardSnapshot,
  continueTask,
  createAndStart,
  createDraft,
  moveTask,
  removeTasks,
  startTask,
  stopTask,
  taskWithOutput,
  taskLogTail,
  workspaceSnapshot,
} from "./manager.js";
import {
  deleteWorkspace,
  getDefaultWorkspaceId,
  getWorkspace,
  initStore,
  flushPersist,
  upsertWorkspace,
} from "./store.js";
import { databaseUrl } from "./db.js";
import type {
  AgentKind,
  BoardLane,
  CreateTaskInput,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  Workspace,
} from "./types.js";
import { browseHome, listDirs } from "./fsbrowse.js";
import {
  CLI_COMMAND_KEYS,
  clearCliPathOverrides,
  getCliPathSettings,
  setCliPathOverrides,
  type CliCommandKey,
} from "./cliPaths.js";
import {
  PROXY_ENV_KEYS,
  clearProxyEnvOverrides,
  getProxyEnvSettings,
  setProxyEnvOverrides,
  type ProxyEnvKey,
} from "./proxyEnv.js";
import { nanoid } from "nanoid";
import { publish } from "./bus.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "web");
const port = Number(process.env.PORT || 8791);
/** Bind address: 127.0.0.1 locally; set HOST=0.0.0.0 in Docker */
const hostname = (process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));


function webhookSecret(): string | null {
  const s = process.env.AGENT_BOARD_WEBHOOK_SECRET?.trim();
  return s ? s : null;
}

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

type HookBody = {
  prompt?: string;
  agent?: string;
  kind?: string;
  cwd?: string;
  workspaceId?: string;
  model?: string;
  title?: string;
  start?: boolean;
  lane?: string;
  mode?: string;
};

function resolveHookStart(body: HookBody): boolean {
  if (body.start === true) return true;
  if (body.start === false) return false;
  const lane = (body.lane || body.mode || "").toLowerCase();
  if (lane === "todo") return true;
  if (lane === "draft") return false;
  return false;
}



async function createTaskViaWebhook(c: Context) {
  const secret = webhookSecret();
  if (!secret) {
    return c.json(
      {
        error: "webhook disabled: set env AGENT_BOARD_WEBHOOK_SECRET",
        hint: "export AGENT_BOARD_WEBHOOK_SECRET='your-secret' then restart agent-board",
      },
      503,
    );
  }
  const auth = c.req.header("authorization") || "";
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  const bearer = m?.[1];
  const headerSecret = c.req.header("x-webhook-secret")?.trim();
  const token = bearer || headerSecret || "";
  if (!token || !secretsEqual(token, secret)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: HookBody;
  try {
    body = (await c.req.json()) as HookBody;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  const kindRaw = (body.agent || body.kind || "").toLowerCase();
  if (!["pi", "claude", "cursor", "devin", "codex"].includes(kindRaw)) {
    return c.json({ error: "agent must be pi|claude|cursor|devin|codex (alias: kind)" }, 400);
  }
  const kind = kindRaw as AgentKind;

  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (workspaceId) {
    if (!getWorkspace(workspaceId)) {
      return c.json({ error: `workspace not found: ${workspaceId}` }, 400);
    }
  } else if (cwd) {
    if (!existsSync(cwd)) return c.json({ error: `cwd not found: ${cwd}` }, 400);
  } else {
    return c.json({ error: "workspaceId or cwd required" }, 400);
  }

  const input: CreateTaskInput = {
    kind,
    workspaceId: workspaceId || undefined,
    cwd: cwd || undefined,
    prompt,
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
  };
  const start = resolveHookStart(body);
  try {
    const task = start ? createAndStart(input) : createDraft(input);
    return c.json({ task, started: start }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}

app.get("/api/browse", (c) => {
  try {
    const path = c.req.query("path") || browseHome;
    return c.json(listDirs(path));
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

app.get("/api/workspaces", (c) =>
  c.json({
    workspaces: workspaceSnapshot(),
    defaultWorkspaceId: getDefaultWorkspaceId(),
  }),
);

app.post("/api/workspaces", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<CreateWorkspaceInput>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!name) return c.json({ error: "name required" }, 400);
  if (!path) return c.json({ error: "path required" }, 400);
  if (!existsSync(path)) return c.json({ error: `path not found: ${path}` }, 400);
  const now = new Date().toISOString();
  const ws: Workspace = {
    id: nanoid(10),
    name,
    path,
    createdAt: now,
    updatedAt: now,
  };
  upsertWorkspace(ws);
  publish({ type: "workspace_upsert", workspace: ws });
  return c.json({ workspace: ws }, 201);
});

app.patch("/api/workspaces/:id", async (c) => {
  const id = c.req.param("id");
  const cur = getWorkspace(id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as UpdateWorkspaceInput;
  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim() : cur.name;
  const path =
    typeof body.path === "string" && body.path.trim() ? body.path.trim() : cur.path;
  if (!existsSync(path)) return c.json({ error: `path not found: ${path}` }, 400);
  const ws: Workspace = {
    ...cur,
    name,
    path,
    updatedAt: new Date().toISOString(),
  };
  upsertWorkspace(ws);
  publish({ type: "workspace_upsert", workspace: ws });
  return c.json({ workspace: ws });
});

app.delete("/api/workspaces/:id", (c) => {
  const id = c.req.param("id");
  if (!getWorkspace(id)) return c.json({ error: "not found" }, 404);
  try {
    deleteWorkspace(id);
    publish({ type: "workspace_delete", workspaceIds: [id] });
    return c.json({ deleted: [id] });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/api/tasks", (c) => {
  const workspaceId = c.req.query("workspaceId") || undefined;
  return c.json({
    tasks: boardSnapshot(workspaceId),
    workspaceId: workspaceId || null,
  });
});

app.get("/api/tasks/:id", (c) => {
  const data = taskWithOutput(c.req.param("id"));
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(data);
});

app.get("/api/tasks/:id/log", (c) => {
  const raw = c.req.query("lines");
  const lines = raw ? Number(raw) : 500;
  const maxLines = Number.isFinite(lines) ? Math.min(Math.max(Math.trunc(lines), 50), 2000) : 500;
  const data = taskLogTail(c.req.param("id"), maxLines);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(data);
});

app.post("/api/tasks", async (c) => {
  const body = (await c.req.json()) as Partial<CreateTaskInput> & { start?: boolean };
  const kind = body.kind as AgentKind;
  if (!kind || !["pi", "claude", "cursor", "devin", "codex"].includes(kind)) {
    return c.json({ error: "kind must be pi|claude|cursor|devin|codex" }, 400);
  }
  if (!body.prompt?.trim()) {
    return c.json({ error: "prompt required" }, 400);
  }
  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (workspaceId) {
    if (!getWorkspace(workspaceId)) {
      return c.json({ error: `workspace not found: ${workspaceId}` }, 400);
    }
  } else if (cwd) {
    if (!existsSync(cwd)) return c.json({ error: `cwd not found: ${cwd}` }, 400);
  } else {
    return c.json({ error: "workspaceId or cwd required" }, 400);
  }
  const input: CreateTaskInput = {
    kind,
    workspaceId: workspaceId || undefined,
    cwd: cwd || undefined,
    prompt: body.prompt.trim(),
    title: body.title,
    model: body.model,
  };
  const start = Boolean(body.start);
  try {
    const task = start ? createAndStart(input) : createDraft(input);
    return c.json({ task }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});


app.post("/api/hooks/tasks", (c) => createTaskViaWebhook(c));
app.post("/webhook/tasks", (c) => createTaskViaWebhook(c));

app.post("/api/tasks/batch-delete", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
  if (!ids.length) return c.json({ error: "ids required" }, 400);
  const result = removeTasks(ids);
  if (!result.deleted.length && result.skipped.length) {
    return c.json(
      {
        error: "Todo/进行中的任务不可删除",
        ...result,
      },
      400,
    );
  }
  return c.json(result);
});

app.post("/api/tasks/:id/start", (c) => {
  try {
    const task = startTask(c.req.param("id"));
    return c.json({ task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg === "not found" ? 404 : 400;
    return c.json({ error: msg }, code);
  }
});

app.post("/api/tasks/:id/move", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { lane?: string };
  const lane = body.lane as BoardLane;
  if (!lane || !["draft", "todo", "running", "done"].includes(lane)) {
    return c.json({ error: "lane must be draft|todo|running|done" }, 400);
  }
  try {
    const task = moveTask(c.req.param("id"), lane);
    return c.json({ task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg === "not found" ? 404 : 400;
    return c.json({ error: msg }, code);
  }
});

app.post("/api/tasks/:id/stop", (c) => {
  try {
    const task = stopTask(c.req.param("id"));
    return c.json({ task });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

app.post("/api/tasks/:id/continue", async (c) => {
  let prompt: string | undefined;
  try {
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
    prompt = body.prompt;
  } catch {
    prompt = undefined;
  }
  try {
    const task = continueTask(c.req.param("id"), prompt);
    return c.json({ task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg === "not found" ? 404 : 400;
    return c.json({ error: msg }, code);
  }
});

app.get("/api/events", (c) => {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "hello",
      data: JSON.stringify({
        type: "hello",
        tasks: boardSnapshot(),
        workspaces: workspaceSnapshot(),
      }),
    });
    const unsub = subscribe((ev) => {
      void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
    });
    const alive = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "{}" });
    }, 15000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(alive);
        unsub();
        resolve();
      });
    });
  });
});



function fullSettings() {
  return { ...getCliPathSettings(), ...getProxyEnvSettings() };
}

app.get("/api/settings", (c) => c.json(fullSettings()));

app.put("/api/settings", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be an object" }, 400);
  }
  const raw = body as {
    cliPaths?: unknown;
    proxyEnv?: unknown;
    clear?: unknown;
  };

  if (raw.clear === true) {
    await clearCliPathOverrides();
    await clearProxyEnvOverrides();
    return c.json(fullSettings());
  }

  const hasCli = raw.cliPaths != null;
  const hasProxy = raw.proxyEnv != null;
  if (!hasCli && !hasProxy) {
    return c.json({ error: "cliPaths and/or proxyEnv required (or clear: true)" }, 400);
  }

  if (hasCli) {
    if (typeof raw.cliPaths !== "object" || Array.isArray(raw.cliPaths)) {
      return c.json({ error: "cliPaths must be an object" }, 400);
    }
    const patch: Partial<Record<CliCommandKey, string>> = {};
    for (const [k, v] of Object.entries(raw.cliPaths as Record<string, unknown>)) {
      if (!(CLI_COMMAND_KEYS as readonly string[]).includes(k)) {
        return c.json({ error: `unknown cliPaths key: ${k}` }, 400);
      }
      if (v != null && typeof v !== "string") {
        return c.json({ error: `cliPaths.${k} must be a string` }, 400);
      }
      patch[k as CliCommandKey] = typeof v === "string" ? v : "";
    }
    await setCliPathOverrides(patch);
  }

  if (hasProxy) {
    if (typeof raw.proxyEnv !== "object" || Array.isArray(raw.proxyEnv)) {
      return c.json({ error: "proxyEnv must be an object" }, 400);
    }
    const patch: Partial<Record<ProxyEnvKey, string>> = {};
    for (const [k, v] of Object.entries(raw.proxyEnv as Record<string, unknown>)) {
      if (!(PROXY_ENV_KEYS as readonly string[]).includes(k)) {
        return c.json({ error: `unknown proxyEnv key: ${k}` }, 400);
      }
      if (v != null && typeof v !== "string") {
        return c.json({ error: `proxyEnv.${k} must be a string` }, 400);
      }
      patch[k as ProxyEnvKey] = typeof v === "string" ? v : "";
    }
    await setProxyEnvOverrides(patch);
  }

  return c.json(fullSettings());
});

app.get("/settings", (c) => {
  const html = readFileSync(join(webRoot, "settings.html"), "utf8");
  return c.html(html);
});
app.get("/settings.html", (c) => c.redirect("/settings", 302));

app.get("/docs", (c) => {
  const html = readFileSync(join(webRoot, "docs.html"), "utf8");
  return c.html(html);
});
app.get("/docs.html", (c) => c.redirect("/docs", 302));

app.use("/*", serveStatic({ root: webRoot }));

async function main() {
  await initStore();
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`agent-board http://${hostname}:${info.port}`);
    console.log(`database ${databaseUrl().replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`);
  });
  const shutdown = async () => {
    await flushPersist();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("failed to start:", err);
  process.exit(1);
});
