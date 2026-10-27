import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { subscribe } from "./bus.js";
import { boardSnapshot, createAndStart, readLogTail, stopTask } from "./manager.js";
import { getTask } from "./store.js";
import type { AgentKind, CreateTaskInput } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "web");
const port = Number(process.env.PORT || 8791);

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/tasks", (c) => c.json({ tasks: boardSnapshot() }));

app.get("/api/tasks/:id", (c) => {
  const t = getTask(c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  return c.json({ task: t, log: readLogTail(t.id) });
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
  const task = createAndStart({
    kind,
    cwd: body.cwd,
    prompt: body.prompt.trim(),
    title: body.title,
    model: body.model,
  });
  return c.json({ task }, 201);
});

app.post("/api/tasks/:id/stop", (c) => {
  try {
    const task = stopTask(c.req.param("id"));
    return c.json({ task });
  } catch {
    return c.json({ error: "not found" }, 404);
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
    // keep alive
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

app.use("/*", serveStatic({ root: webRoot }));

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`agent-board http://127.0.0.1:${info.port}`);
});
