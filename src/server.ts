import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subscribe } from "./bus.js";
import {
  boardSnapshot,
  continueTask,
  createAndStart,
  createDraft,
  moveTask,
  removeTasks,
  presentBoardTask,
  beginDraining,
  isDraining,
  shutdownManager,
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
  closePool,
  flushPersist,
  isPersistDegraded,
  persistFailureMessage,
  upsertWorkspace,
} from "./store.js";
import { redactDatabaseUrl, upsertMetaMany } from "./db.js";
import type {
  AgentKind,
  BoardLane,
  CreateTaskInput,
  BoardEvent,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  Workspace,
} from "./types.js";
import { normalizeWorkspaceSettings } from "./workspaceApply.js";
import { browseHome, listDirs } from "./fsbrowse.js";
import { workspaceGitStatus } from "./gitStatus.js";
import {
  CLI_COMMAND_KEYS,
  applyCliPathMemory,
  getCliPathSettingsResolved,
  planCliPathOverrides,
  type CliCommandKey,
} from "./cliPaths.js";
import {
  PROXY_ENV_KEYS,
  applyProxyEnvMemory,
  getProxyEnvSettings,
  planProxyEnvOverrides,
  type ProxyEnvKey,
} from "./proxyEnv.js";
import {
  applyQuickPromptsMemory,
  getQuickPromptSettings,
  planQuickPrompts,
} from "./quickPrompts.js";
import {
  applyCodexSandboxMemory,
  getCodexSandboxSettings,
  planCodexSandbox,
} from "./codexSandbox.js";
import { nanoid } from "nanoid";
import { publish } from "./bus.js";
import {
  absoluteUploadPath,
  ensureUploadsDir,
  isAllowedImageMime,
  isSafeStoredName,
  isSafeUploadName,
  MAX_ATTACHMENT_BYTES,
  MAX_UPLOAD_BYTES,
  mimeForStoredName,
  normalizeAttachmentsInput,
  openUploadNoFollow,
  saveAttachmentFile,
  saveUploadFile,
  sniffImageMime,
} from "./uploads.js";
import { Readable } from "node:stream";
import { httpStatusOf, HttpError } from "./httpError.js";
import {
  assertTextLimit,
  MAX_BATCH_IDS,
  MAX_JSON_BODY_BYTES,
  MAX_MODEL_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TITLE_CHARS,
  MAX_UPLOAD_OVERHEAD_BYTES,
} from "./limits.js";
import { resolveAllowedDirectory } from "./paths.js";
import { withSettingsLock } from "./settingsLock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "web");
const port = Number(process.env.PORT || 8791);
/** Bind address: 127.0.0.1 locally; set HOST=0.0.0.0 in Docker */
const hostname = (process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";

const app = new Hono();

const MAX_UPLOAD_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + MAX_UPLOAD_OVERHEAD_BYTES;

app.use("*", async (c, next) => {
  if (isDraining() && c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
    return c.json({ error: "shutting down" }, 503);
  }
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Content-Security-Policy", "frame-ancestors 'self'");
});

app.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return next();
  }
  const len = c.req.header("content-length");
  if (len != null && len !== "") {
    const n = Number(len);
    if (!Number.isFinite(n) || n < 0) {
      return c.json({ error: "invalid content-length" }, 400);
    }
  }
  const max =
    c.req.path === "/api/uploads" ? MAX_UPLOAD_REQUEST_BYTES : MAX_JSON_BODY_BYTES;
  return bodyLimit({
    maxSize: max,
    onError: (ctx) =>
      ctx.json({ error: `request body too large (limit ${max} bytes)` }, 413),
  })(c, next);
});

app.get("/api/health", (c) => {
  if (isPersistDegraded()) {
    return c.json(
      { ok: false, db: { ok: false, error: persistFailureMessage() || "persist failed" } },
      503,
    );
  }
  return c.json({ ok: true, db: { ok: true } });
});

function errorJson(c: Context, err: unknown, fallback = 400) {
  const msg = err instanceof Error ? err.message : String(err);
  const status = httpStatusOf(err, fallback);
  return c.json({ error: msg }, status as 400);
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "body must be an object");
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string, opts?: { required?: boolean; max?: number }): string {
  const v = body[key];
  if (v == null || v === "") {
    if (opts?.required) throw new HttpError(400, `${key} required`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  const trimmed = v.trim();
  if (opts?.required && !trimmed) throw new HttpError(400, `${key} required`);
  if (opts?.max) assertTextLimit(v, opts.max, key);
  return opts?.required ? trimmed : v;
}

function parseStrictBool(v: unknown, key: string): boolean | undefined {
  if (v == null) return undefined;
  if (v === true) return true;
  if (v === false) return false;
  throw new HttpError(400, `${key} must be a boolean`);
}


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

function resolveHookStart(body: Record<string, unknown>): boolean {
  if ("start" in body && body.start != null) {
    const start = parseStrictBool(body.start, "start");
    if (start != null) return start;
  }
  const laneRaw = body.lane ?? body.mode;
  const lane = typeof laneRaw === "string" ? laneRaw.toLowerCase() : "";
  if (lane === "todo") return true;
  if (lane === "draft") return false;
  return false;
}

function assertWorkspaceSettingsSize(settings: { systemPrompt?: string; skills?: string[]; mcp?: string } | undefined): void {
  if (!settings) return;
  if (settings.systemPrompt) assertTextLimit(settings.systemPrompt, MAX_PROMPT_CHARS, "systemPrompt");
  if (settings.mcp) assertTextLimit(settings.mcp, MAX_PROMPT_CHARS, "mcp");
  for (const skill of settings.skills || []) {
    assertTextLimit(skill, 2_000, "skills");
  }
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

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(c);
  } catch (e) {
    return errorJson(c, e);
  }

  let prompt = "";
  let start = false;
  try {
    prompt = requireString(body, "prompt", { required: true, max: MAX_PROMPT_CHARS });
    if (body.title != null) requireString(body, "title", { max: MAX_TITLE_CHARS });
    if (body.model != null) requireString(body, "model", { max: MAX_MODEL_CHARS });
    start = resolveHookStart(body);
  } catch (e) {
    return errorJson(c, e);
  }

  const agent = body.agent ?? body.kind;
  const kindRaw = typeof agent === "string" ? agent.toLowerCase() : "";
  if (!["pi", "claude", "cursor", "devin", "codex"].includes(kindRaw)) {
    return c.json({ error: "agent must be pi|claude|cursor|devin|codex (alias: kind)" }, 400);
  }
  const kind = kindRaw as AgentKind;

  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (body.workspaceId != null && typeof body.workspaceId !== "string") {
    return c.json({ error: "workspaceId must be a string" }, 400);
  }
  if (body.cwd != null && typeof body.cwd !== "string") {
    return c.json({ error: "cwd must be a string" }, 400);
  }
  try {
    if (workspaceId) {
      if (!getWorkspace(workspaceId)) {
        return c.json({ error: `workspace not found: ${workspaceId}` }, 400);
      }
    } else if (cwd) {
      resolveAllowedDirectory(cwd, "cwd");
    } else {
      return c.json({ error: "workspaceId or cwd required" }, 400);
    }
  } catch (e) {
    return errorJson(c, e);
  }

  const input: CreateTaskInput = {
    kind,
    workspaceId: workspaceId || undefined,
    cwd: cwd || undefined,
    prompt,
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
  };
  try {
    const task = start ? await createAndStart(input) : await createDraft(input);
    return c.json({ task, started: start }, 201);
  } catch (e) {
    return errorJson(c, e, 500);
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
  try {
    const body = await readJsonObject(c);
    const name = requireString(body, "name", { required: true, max: MAX_TITLE_CHARS });
    const rawPath = requireString(body, "path", { required: true, max: 4_000 });
    const path = resolveAllowedDirectory(rawPath, "path");
    const now = new Date().toISOString();
    const ws: Workspace = {
      id: nanoid(10),
      name,
      path,
      createdAt: now,
      updatedAt: now,
    };
    await upsertWorkspace(ws);
    publish({ type: "workspace_upsert", workspace: ws });
    return c.json({ workspace: ws }, 201);
  } catch (e) {
    return errorJson(c, e, 500);
  }
});

app.get("/api/workspaces/:id", (c) => {
  const id = c.req.param("id");
  const ws = getWorkspace(id);
  if (!ws) return c.json({ error: "not found" }, 404);
  return c.json({
    workspace: ws,
    defaultWorkspaceId: getDefaultWorkspaceId(),
  });
});

/** Read-only git status. The path always comes from the stored workspace, never from the query string. */
app.get("/api/workspaces/:id/git-status", async (c) => {
  const id = c.req.param("id");
  const ws = getWorkspace(id);
  if (!ws) return c.json({ error: "not found" }, 404);
  try {
    const root = resolveAllowedDirectory(ws.path, "path");
    const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    const status = await workspaceGitStatus(root, { refresh });
    return c.json({ workspaceId: id, ...status });
  } catch (e) {
    return errorJson(c, e, 400);
  }
});

app.patch("/api/workspaces/:id", async (c) => {
  const id = c.req.param("id");
  const cur = getWorkspace(id);
  if (!cur) return c.json({ error: "not found" }, 404);
  try {
    const body = await readJsonObject(c);
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : cur.name;
    if (body.name != null && typeof body.name !== "string") {
      throw new HttpError(400, "name must be a string");
    }
    const rawPath =
      typeof body.path === "string" && body.path.trim() ? body.path.trim() : cur.path;
    if (body.path != null && typeof body.path !== "string") {
      throw new HttpError(400, "path must be a string");
    }
    const path = resolveAllowedDirectory(rawPath, "path");
    if (typeof name === "string") assertTextLimit(name, MAX_TITLE_CHARS, "name");
    const settings =
      "settings" in body
        ? normalizeWorkspaceSettings(body.settings)
        : cur.settings;
    assertWorkspaceSettingsSize(settings);
    const ws: Workspace = {
      ...cur,
      name,
      path,
      settings,
      updatedAt: new Date().toISOString(),
    };
    await upsertWorkspace(ws);
    publish({ type: "workspace_upsert", workspace: ws });
    return c.json({ workspace: ws });
  } catch (e) {
    return errorJson(c, e, 500);
  }
});

app.delete("/api/workspaces/:id", async (c) => {
  const id = c.req.param("id");
  if (!getWorkspace(id)) return c.json({ error: "not found" }, 404);
  try {
    await deleteWorkspace(id);
    publish({ type: "workspace_delete", workspaceIds: [id] });
    return c.json({ deleted: [id] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("persist failed")) return errorJson(c, err, 500);
    return c.json({ error: msg }, 400);
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
  try {
    const body = await readJsonObject(c);
    const kindRaw = body.kind;
    if (typeof kindRaw !== "string" || !["pi", "claude", "cursor", "devin", "codex"].includes(kindRaw)) {
      return c.json({ error: "kind must be pi|claude|cursor|devin|codex" }, 400);
    }
    const prompt = requireString(body, "prompt", { required: true, max: MAX_PROMPT_CHARS });
    const title = body.title == null ? undefined : requireString(body, "title", { max: MAX_TITLE_CHARS });
    const model = body.model == null ? undefined : requireString(body, "model", { max: MAX_MODEL_CHARS });
    const start = parseStrictBool(body.start, "start") === true;
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (body.workspaceId != null && typeof body.workspaceId !== "string") {
      throw new HttpError(400, "workspaceId must be a string");
    }
    if (body.cwd != null && typeof body.cwd !== "string") {
      throw new HttpError(400, "cwd must be a string");
    }
    if (workspaceId) {
      if (!getWorkspace(workspaceId)) {
        return c.json({ error: `workspace not found: ${workspaceId}` }, 400);
      }
    } else if (cwd) {
      resolveAllowedDirectory(cwd, "cwd");
    } else {
      return c.json({ error: "workspaceId or cwd required" }, 400);
    }
    const attachments = normalizeAttachmentsInput(body.attachments);
    const input: CreateTaskInput = {
      kind: kindRaw as AgentKind,
      workspaceId: workspaceId || undefined,
      cwd: cwd || undefined,
      prompt,
      title: title || undefined,
      model: model || undefined,
      attachments: attachments.length ? attachments : undefined,
    };
    const task = start ? await createAndStart(input) : await createDraft(input);
    return c.json({ task }, 201);
  } catch (e) {
    return errorJson(c, e, 500);
  }
});


app.post("/api/hooks/tasks", (c) => createTaskViaWebhook(c));
app.post("/webhook/tasks", (c) => createTaskViaWebhook(c));

app.post("/api/tasks/batch-delete", async (c) => {
  try {
    const body = await readJsonObject(c);
    if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== "string")) {
      return c.json({ error: "ids must be an array of strings" }, 400);
    }
    const ids = body.ids as string[];
    if (!ids.length) return c.json({ error: "ids required" }, 400);
    if (ids.length > MAX_BATCH_IDS) {
      return c.json({ error: `ids exceeds ${MAX_BATCH_IDS}` }, 413);
    }
    const result = await removeTasks(ids);
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
  } catch (e) {
    return errorJson(c, e, 500);
  }
});

app.post("/api/tasks/:id/start", async (c) => {
  try {
    const task = await startTask(c.req.param("id"));
    return c.json({ task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg === "not found" ? 404 : httpStatusOf(err, 400);
    return c.json({ error: msg }, code as 400);
  }
});

app.post("/api/tasks/:id/move", async (c) => {
  try {
    const body = await readJsonObject(c);
    const lane = body.lane;
    if (typeof lane !== "string" || !["draft", "todo", "running", "done", "archived"].includes(lane)) {
      return c.json({ error: "lane must be draft|todo|running|done|archived" }, 400);
    }
    const task = await moveTask(c.req.param("id"), lane as BoardLane);
    return c.json({ task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "invalid JSON body" || msg === "body must be an object") {
      return c.json({ error: msg }, 400);
    }
    const code = msg === "not found" ? 404 : httpStatusOf(err, 400);
    return c.json({ error: msg }, code as 400);
  }
});

app.post("/api/tasks/:id/stop", async (c) => {
  try {
    const task = await stopTask(c.req.param("id"));
    return c.json({ task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "not found") return c.json({ error: "not found" }, 404);
    return errorJson(c, err, 500);
  }
});

app.post("/api/tasks/:id/continue", async (c) => {
  let prompt: string | undefined;
  try {
    const raw = await c.req.text();
    if (raw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ error: "body must be an object" }, 400);
      }
      const body = parsed as Record<string, unknown>;
      if (body.prompt != null) {
        prompt = requireString(body, "prompt", { max: MAX_PROMPT_CHARS });
      }
    }
  } catch (err) {
    return errorJson(c, err);
  }
  try {
    const task = await continueTask(c.req.param("id"), prompt);
    return c.json({ task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg === "not found" ? 404 : httpStatusOf(err, 400);
    return c.json({ error: msg }, code as 400);
  }
});

app.get("/api/events", (c) => {
  return streamSSE(c, async (stream) => {
    const MAX_QUEUED = 100;
    const queued: { event: string; data: string }[] = [];
    let closed = false;
    let pumping = false;
    let alive: ReturnType<typeof setInterval> | undefined;
    let finishWait: (() => void) | undefined;
    let unsub = () => {};
    const finish = () => {
      if (closed) {
        finishWait?.();
        return;
      }
      closed = true;
      queued.length = 0;
      if (alive) clearInterval(alive);
      try { unsub(); } catch { /* ignore */ }
      finishWait?.();
      try {
        stream.abort();
      } catch {
        /* already closed */
      }
    };
    const pump = async () => {
      if (pumping || closed) return;
      pumping = true;
      try {
        while (queued.length && !closed) {
          const item = queued.shift()!;
          await stream.writeSSE(item);
        }
      } catch {
        finish();
      } finally {
        pumping = false;
        if (queued.length && !closed) void pump();
      }
    };
    const enqueue = (event: string, data: string) => {
      if (closed) return;
      if (queued.length >= MAX_QUEUED) {
        finish();
        return;
      }
      queued.push({ event, data });
      void pump();
    };
    unsub = subscribe((ev) => {
      enqueue(ev.type, JSON.stringify(presentTaskEvent(ev)));
    });
    const signal = c.req.raw.signal;
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
    stream.onAbort(finish);
    try {
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({
          type: "hello",
          tasks: boardSnapshot(),
          workspaces: workspaceSnapshot(),
        }),
      });
      await pump();
      if (closed) return;
      alive = setInterval(() => {
        enqueue("ping", "{}");
      }, 15000);
      await new Promise<void>((resolve) => {
        if (closed || signal?.aborted) {
          finish();
          resolve();
          return;
        }
        finishWait = () => resolve();
        const done = () => finish();
        signal?.addEventListener("abort", done, { once: true });
        stream.onAbort(done);
      });
    } finally {
      finish();
    }
  });
});

function presentTaskEvent(ev: BoardEvent): BoardEvent {
  if (ev.type === "task_upsert" && ev.task) {
    return { ...ev, task: presentBoardTask(ev.task) };
  }
  return ev;
}



async function fullSettings() {
  return {
    ...(await getCliPathSettingsResolved()),
    ...getProxyEnvSettings(),
    ...getQuickPromptSettings(),
    ...getCodexSandboxSettings(),
  };
}

app.get("/api/settings", async (c) => c.json(await fullSettings()));

app.put("/api/settings", async (c) => {
  let raw: Record<string, unknown>;
  try {
    raw = await readJsonObject(c);
  } catch (e) {
    return errorJson(c, e);
  }

  return withSettingsLock(async () => {
  if ("clear" in raw && raw.clear != null && typeof raw.clear !== "boolean") {
    return c.json({ error: "clear must be a boolean" }, 400);
  }

  if (raw.clear === true) {
    try {
      // Validate nothing else is required. One transaction, then swap memory.
      // Quick prompts are user content and are kept.
      await upsertMetaMany([
        ["cli_paths", "{}"],
        ["proxy_env", "{}"],
        ["codex_sandbox", "true"],
      ]);
      applyCliPathMemory({});
      applyProxyEnvMemory({});
      applyCodexSandboxMemory(true);
      return c.json(await fullSettings());
    } catch (err) {
      return errorJson(c, err, 500);
    }
  }

  const hasCli = raw.cliPaths != null;
  const hasProxy = raw.proxyEnv != null;
  const hasQuick = raw.quickPrompts != null;
  const hasCodexSandbox = raw.codexSandbox != null;
  if (!hasCli && !hasProxy && !hasQuick && !hasCodexSandbox) {
    return c.json({ error: "cliPaths, proxyEnv, quickPrompts, and/or codexSandbox required (or clear: true)" }, 400);
  }

  let cliPlan: ReturnType<typeof planCliPathOverrides> | undefined;
  let proxyPlan: ReturnType<typeof planProxyEnvOverrides> | undefined;

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
    cliPlan = planCliPathOverrides(patch);
  }

  if (hasProxy) {
    if (typeof raw.proxyEnv !== "object" || Array.isArray(raw.proxyEnv)) {
      return c.json({ error: "proxyEnv must be an object" }, 400);
    }
    const patch: Partial<
      Record<CliCommandKey, Partial<Record<ProxyEnvKey, string>>>
    > = {};
    for (const [kind, kindVal] of Object.entries(
      raw.proxyEnv as Record<string, unknown>,
    )) {
      if (!(CLI_COMMAND_KEYS as readonly string[]).includes(kind)) {
        return c.json({ error: `unknown proxyEnv kind: ${kind}` }, 400);
      }
      if (kindVal == null || typeof kindVal !== "object" || Array.isArray(kindVal)) {
        return c.json({ error: `proxyEnv.${kind} must be an object` }, 400);
      }
      const kindPatch: Partial<Record<ProxyEnvKey, string>> = {};
      for (const [k, v] of Object.entries(kindVal as Record<string, unknown>)) {
        if (!(PROXY_ENV_KEYS as readonly string[]).includes(k)) {
          return c.json({ error: `unknown proxyEnv.${kind} key: ${k}` }, 400);
        }
        if (v != null && typeof v !== "string") {
          return c.json({ error: `proxyEnv.${kind}.${k} must be a string` }, 400);
        }
        kindPatch[k as ProxyEnvKey] = typeof v === "string" ? v : "";
      }
      patch[kind as CliCommandKey] = kindPatch;
    }
    proxyPlan = planProxyEnvOverrides(patch);
  }

  let quickPlan: ReturnType<typeof planQuickPrompts> | undefined;
  let codexPlan: ReturnType<typeof planCodexSandbox> | undefined;
  try {
    if (hasQuick) quickPlan = planQuickPrompts(raw.quickPrompts);
    if (hasCodexSandbox) codexPlan = planCodexSandbox(raw.codexSandbox);
  } catch (err) {
    return errorJson(c, err);
  }

  const entries: Array<readonly [string, string]> = [];
  if (cliPlan) entries.push(["cli_paths", cliPlan.json]);
  if (proxyPlan) entries.push(["proxy_env", proxyPlan.json]);
  if (quickPlan) entries.push(["quick_prompts", quickPlan.json]);
  if (codexPlan) entries.push(["codex_sandbox", codexPlan.json]);
  try {
    await upsertMetaMany(entries);
  } catch (err) {
    return errorJson(c, err, 500);
  }
  if (cliPlan) applyCliPathMemory(cliPlan.next);
  if (proxyPlan) applyProxyEnvMemory(proxyPlan.next);
  if (quickPlan) applyQuickPromptsMemory(quickPlan.next);
  if (codexPlan) applyCodexSandboxMemory(codexPlan.next);

  return c.json(await fullSettings());
  });
});

app.post("/api/uploads", async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    const attachmentFlag = body["attachment"];
    const attachmentText = typeof attachmentFlag === "string" ? attachmentFlag : "";
    const asAttachment =
      c.req.query("as") === "attachment" ||
      body["as"] === "attachment" ||
      attachmentText === "true" ||
      attachmentText === "1";
    const raw = body["file"] ?? body["attachment"] ?? body["image"];
    const file = Array.isArray(raw) ? raw[0] : raw;
    if (!(file instanceof File)) {
      return c.json({ error: "请上传文件（字段名 file）" }, 400);
    }
    if (asAttachment) {
      if (typeof file.size === "number" && file.size > MAX_ATTACHMENT_BYTES) {
        return c.json(
          { error: `附件过大（上限 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB）` },
          400,
        );
      }
      const saved = await saveAttachmentFile(file);
      return c.json(saved, 201);
    }
    if (!isAllowedImageMime(file.type || "")) {
      return c.json({ error: "仅支持 PNG / JPEG / GIF / WebP 图片；通用附件请加 ?as=attachment" }, 400);
    }
    if (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: `图片过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）` }, 400);
    }
    const saved = await saveUploadFile(file);
    return c.json(saved, 201);
  } catch (err) {
    const status = httpStatusOf(err, typeof (err as { status?: number })?.status === "number"
      ? (err as { status: number }).status
      : 500);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, status as 400 | 500);
  }
});

app.get("/uploads/:name", async (c) => {
  const name = c.req.param("name");
  if (!isSafeStoredName(name) && !isSafeUploadName(name)) return c.notFound();
  const abs = absoluteUploadPath(name);
  const opened = abs ? openUploadNoFollow(abs) : null;
  if (!opened) return c.notFound();
  const filename = c.req.query("filename")?.trim() || name;
  const safe = filename.replace(/["\r\n]/g, "_");
  const download = c.req.query("download") === "1" || c.req.query("download") === "true";
  let sniffed: string | null = null;
  try {
    const head = Buffer.alloc(16);
    readSync(opened.fd, head, 0, 16, 0);
    sniffed = sniffImageMime(head);
  } catch {
    sniffed = null;
  }
  const inlineImage = Boolean(sniffed) && isSafeUploadName(name);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Length", String(opened.size));
  c.header("Content-Security-Policy", "sandbox; default-src 'none'");
  if (inlineImage && !download) {
    c.header("Content-Type", sniffed!);
    c.header("Cache-Control", "private, max-age=3600");
  } else {
    // Non-images (and explicit downloads) are always attachments.
    // A query flag cannot turn this off.
    c.header("Content-Type", "application/octet-stream");
    c.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
    );
    c.header("Cache-Control", "private, no-store");
  }
  const nodeStream = createReadStream(abs!, { fd: opened.fd, autoClose: true, start: 0 });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return c.body(webStream);
});

app.get("/workspaces/:id/settings", (c) => {
  const html = readFileSync(join(webRoot, "workspace-settings.html"), "utf8");
  return c.html(html);
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
  ensureUploadsDir();
  await initStore();
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`agent-board http://${hostname}:${info.port}`);
    console.log(`database ${redactDatabaseUrl()}`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    beginDraining();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      await shutdownManager();
    } catch (err) {
      console.error("[shutdown] runners:", err);
    }
    try {
      await flushPersist();
    } catch (err) {
      console.error("[db] flush on shutdown failed:", err);
    }
    try {
      await closePool();
    } catch (err) {
      console.error("[db] close pool failed:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

export { app };

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
  });
}
