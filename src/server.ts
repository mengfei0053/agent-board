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
} from "./manager.js";
import { getTask, initStore, flushPersist } from "./store.js";
import { databaseUrl } from "./db.js";
import type { AgentKind, BoardLane, CreateTaskInput } from "./types.js";
import { browseHome, listDirs } from "./fsbrowse.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "web");
const port = Number(process.env.PORT || 8791);

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
  if (!["pi", "claude", "cursor"].includes(kindRaw)) {
    return c.json({ error: "agent must be pi|claude|cursor (alias: kind)" }, 400);
  }
  const kind = kindRaw as AgentKind;

  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  if (!existsSync(cwd)) return c.json({ error: `cwd not found: ${cwd}` }, 400);

  const input: CreateTaskInput = {
    kind,
    cwd,
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

app.get("/api/tasks", (c) => c.json({ tasks: boardSnapshot() }));

app.get("/api/tasks/:id", (c) => {
  const data = taskWithOutput(c.req.param("id"));
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(data);
});

app.post("/api/tasks", async (c) => {
  const body = (await c.req.json()) as Partial<CreateTaskInput>;
  const kind = body.kind as AgentKind;
  if (!kind || !["pi", "claude", "cursor"].includes(kind)) {
    return c.json({ error: "kind must be pi|claude|cursor" }, 400);
  }
  if (!body.cwd || !body.prompt?.trim()) {
    return c.json({ error: "cwd and prompt required" }, 400);
  }
  if (!existsSync(body.cwd)) {
    return c.json({ error: `cwd not found: ${body.cwd}` }, 400);
  }
  const input = {
    kind,
    cwd: body.cwd,
    prompt: body.prompt.trim(),
    title: body.title,
    model: body.model,
  };
  const start = Boolean((body as { start?: boolean }).start);
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
      data: JSON.stringify({ type: "hello", tasks: boardSnapshot() }),
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


app.get("/docs", (c) => {
  const html = readFileSync(join(webRoot, "docs.html"), "utf8");
  return c.html(html);
});
app.get("/docs.html", (c) => c.redirect("/docs", 302));

app.use("/*", serveStatic({ root: webRoot }));

async function main() {
  await initStore();
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log(`agent-board http://127.0.0.1:${info.port}`);
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
