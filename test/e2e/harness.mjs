/**
 * Shared mock API + static server + puppeteer helpers for agent-board e2e.
 * No Postgres / production DB.
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const webRoot = join(root, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  if (rel === "/settings") rel = "/settings.html";
  if (rel === "/docs") rel = "/docs.html";
  if (/^\/workspaces\/[^/]+\/settings\/?$/.test(rel)) {
    rel = "/workspace-settings.html";
  }
  const abs = join(webRoot, rel.replace(/^\//, ""));
  if (!abs.startsWith(webRoot) || !existsSync(abs)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const data = readFileSync(abs);
  res.writeHead(200, { "content-type": MIME[extname(abs)] || "application/octet-stream" });
  res.end(data);
}

/** @typedef {{ id: string, name: string, path: string, createdAt: string, updatedAt: string, settings?: object }} Workspace */
/** @typedef {{ id: string, title: string, kind: string, cwd: string, workspaceId: string, prompt: string, model?: string, iteration: number, status: string, createdAt: string, updatedAt: string, prompts?: object[], summary?: string, lastEvent?: string, endedAt?: string }} Task */

/**
 * In-memory board state for mock API.
 * @returns {{
 *   workspaces: Map<string, Workspace>,
 *   tasks: Map<string, Task>,
 *   defaultWorkspaceId: string,
 *   taskSeq: number,
 * }}
 */
export function createState(seed = {}) {
  const now = "2026-01-01T00:00:00.000Z";
  const wsDefault = seed.wsDefault || {
    id: "ws_default",
    name: "默认工作区",
    path: "/tmp/agent-board-default",
    createdAt: now,
    updatedAt: now,
  };
  const wsExtra = seed.wsExtra || {
    id: "ws_extra",
    name: "可删工作区",
    path: "/tmp/agent-board-extra",
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
  const workspaces = new Map([
    [wsDefault.id, { ...wsDefault }],
    [wsExtra.id, { ...wsExtra }],
  ]);
  /** @type {Map<string, Task>} */
  const tasks = new Map();
  for (const t of seed.tasks || []) tasks.set(t.id, { ...t });
  return {
    workspaces,
    tasks,
    defaultWorkspaceId: seed.defaultWorkspaceId || wsDefault.id,
    taskSeq: seed.taskSeq || 1,
  };
}

/**
 * @param {ReturnType<typeof createState>} state
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, u: URL) => boolean | Promise<boolean>} [extra]
 */
export function createMockServer(state, extra) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const { pathname } = u;

    if (extra) {
      const handled = await extra(req, res, u);
      if (handled) return;
    }

    if (pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const hello = {
        type: "hello",
        tasks: [...state.tasks.values()],
        workspaces: [...state.workspaces.values()],
      };
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      const iv = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 15000);
      req.on("close", () => clearInterval(iv));
      return;
    }

    if (pathname === "/api/workspaces" && req.method === "GET") {
      return json(res, 200, {
        workspaces: [...state.workspaces.values()],
        defaultWorkspaceId: state.defaultWorkspaceId,
      });
    }

    if (pathname === "/api/workspaces" && req.method === "POST") {
      const body = await readBody(req);
      const id = `ws_${Date.now()}`;
      const now = new Date().toISOString();
      const ws = {
        id,
        name: String(body.name || "").trim() || "未命名",
        path: String(body.path || "").trim() || "/tmp/new",
        createdAt: now,
        updatedAt: now,
      };
      state.workspaces.set(id, ws);
      return json(res, 201, { workspace: ws });
    }

    const wsOne = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if (wsOne) {
      const id = decodeURIComponent(wsOne[1]);
      const cur = state.workspaces.get(id);
      if (req.method === "GET") {
        if (!cur) return json(res, 404, { error: "not found" });
        return json(res, 200, { workspace: cur, defaultWorkspaceId: state.defaultWorkspaceId });
      }
      if (req.method === "PATCH") {
        if (!cur) return json(res, 404, { error: "not found" });
        const body = await readBody(req);
        if (typeof body.name === "string" && body.name.trim()) cur.name = body.name.trim();
        if (typeof body.path === "string" && body.path.trim()) cur.path = body.path.trim();
        if ("settings" in body) {
          const s = body.settings || {};
          const next = {};
          if (typeof s.systemPrompt === "string" && s.systemPrompt.trim()) {
            next.systemPrompt = s.systemPrompt.trim();
          }
          const skills = Array.isArray(s.skills)
            ? s.skills.map(String).map((x) => x.trim()).filter(Boolean)
            : [];
          if (skills.length) next.skills = skills;
          if (typeof s.mcp === "string" && s.mcp.trim()) next.mcp = s.mcp.trim();
          cur.settings = Object.keys(next).length ? next : undefined;
        }
        cur.updatedAt = new Date().toISOString();
        return json(res, 200, { workspace: cur });
      }
      if (req.method === "DELETE") {
        if (!cur) return json(res, 404, { error: "not found" });
        if (id === state.defaultWorkspaceId) {
          return json(res, 400, { error: "cannot delete the default workspace" });
        }
        for (const t of state.tasks.values()) {
          if (t.workspaceId === id) {
            return json(res, 400, {
              error: "workspace still has tasks; move or delete them first",
            });
          }
        }
        state.workspaces.delete(id);
        return json(res, 200, { deleted: [id] });
      }
    }

    if (pathname === "/api/tasks" && req.method === "GET") {
      const workspaceId = u.searchParams.get("workspaceId") || undefined;
      let list = [...state.tasks.values()];
      if (workspaceId) list = list.filter((t) => t.workspaceId === workspaceId);
      return json(res, 200, { tasks: list, workspaceId: workspaceId || null });
    }

    if (pathname === "/api/tasks" && req.method === "POST") {
      const body = await readBody(req);
      const wsId = String(body.workspaceId || state.defaultWorkspaceId);
      const ws = state.workspaces.get(wsId);
      if (!ws) return json(res, 400, { error: `workspace not found: ${wsId}` });
      if (!body.prompt?.trim()) return json(res, 400, { error: "prompt required" });
      const id = `task_e2e_${state.taskSeq++}`;
      const createdAt = new Date().toISOString();
      const plain = String(body.prompt).trim();
      /** @type {Task} */
      let task = {
        id,
        title: (body.title && String(body.title).trim()) || plain.slice(0, 48) || "task",
        kind: body.kind || "pi",
        cwd: ws.path,
        workspaceId: wsId,
        prompt: plain,
        model: (body.model && String(body.model).trim()) || "mock-model",
        iteration: 1,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
        prompts: [{ iteration: 1, prompt: plain, at: createdAt }],
      };
      if (body.start) {
        task = {
          ...task,
          status: "queued",
          summary: "starting",
          lastEvent: "start",
          updatedAt: new Date().toISOString(),
        };
      }
      state.tasks.set(id, task);
      return json(res, 201, { task });
    }

    const taskOne = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskOne && req.method === "GET") {
      const id = decodeURIComponent(taskOne[1]);
      const task = state.tasks.get(id);
      if (!task) return json(res, 404, { error: "not found" });
      return json(res, 200, { task, logLineCount: 0, log: [] });
    }

    const taskMove = pathname.match(/^\/api\/tasks\/([^/]+)\/move$/);
    if (taskMove && req.method === "POST") {
      const id = decodeURIComponent(taskMove[1]);
      const t = state.tasks.get(id);
      if (!t) return json(res, 404, { error: "not found" });
      const body = await readBody(req);
      const lane = body.lane;
      const now = new Date().toISOString();
      if (lane === "todo" || lane === "running") {
        if (["queued", "running", "blocked"].includes(t.status)) {
          return json(res, 200, { task: t });
        }
        Object.assign(t, {
          status: lane === "running" ? "running" : "queued",
          summary: "starting",
          lastEvent: "start",
          updatedAt: now,
        });
        return json(res, 200, { task: t });
      }
      if (lane === "draft") {
        Object.assign(t, {
          status: "draft",
          summary: "moved to draft",
          lastEvent: "move_draft",
          updatedAt: now,
        });
        return json(res, 200, { task: t });
      }
      if (lane === "archived") {
        const prior =
          t.status === "succeeded" || t.status === "failed" || t.status === "stopped"
            ? t.status
            : "stopped";
        Object.assign(t, {
          status: "archived",
          endedAt: t.endedAt || now,
          summary: t.summary ?? "archived",
          lastEvent: `archive:${prior}`,
          updatedAt: now,
        });
        return json(res, 200, { task: t });
      }
      // done
      if (["succeeded", "failed", "stopped"].includes(t.status)) {
        return json(res, 200, { task: t });
      }
      if (t.status === "draft") {
        Object.assign(t, {
          status: "stopped",
          endedAt: now,
          summary: "moved to done without running",
          lastEvent: "move_done",
          updatedAt: now,
        });
        return json(res, 200, { task: t });
      }
      Object.assign(t, {
        status: "stopped",
        endedAt: now,
        summary: "stopped",
        lastEvent: "stop",
        updatedAt: now,
      });
      return json(res, 200, { task: t });
    }

    if (pathname === "/api/tasks/batch-delete" && req.method === "POST") {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
      if (!ids.length) return json(res, 400, { error: "ids required" });
      const deleted = [];
      const skipped = [];
      for (const id of [...new Set(ids)]) {
        const t = state.tasks.get(id);
        if (!t) continue;
        if (t.status === "queued" || t.status === "running") {
          skipped.push({
            id,
            status: t.status,
            reason: "Todo/进行中的任务不可删除，请先停止或等其结束",
          });
          continue;
        }
        state.tasks.delete(id);
        deleted.push(id);
      }
      if (!deleted.length && skipped.length) {
        return json(res, 400, { error: "没有可删除的任务", deleted, skipped });
      }
      return json(res, 200, { deleted, skipped, stopped: [] });
    }

    if (pathname.startsWith("/api/")) {
      return json(res, 404, { error: `mock missing ${pathname}` });
    }

    serveStatic(req, res, pathname);
  });
}

export async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { port, base: `http://127.0.0.1:${port}` };
}

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1280, height: 900 },
  });
}

/** Open workspace context menu for a given workspace id. */
export async function openWsContextMenu(page, workspaceId) {
  return page.evaluate((id) => {
    const item = document.querySelector(`.ws-item[data-workspace-id="${id}"]`);
    if (!item) return { ok: false, reason: "no item" };
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 20,
        clientY: rect.top + 10,
        button: 2,
      }),
    );
    const menu = document.getElementById("ws-context-menu");
    return {
      ok: Boolean(menu && !menu.classList.contains("hidden")),
    };
  }, workspaceId);
}

/** Drag a card onto a swimlane via dragTaskId fallback (HTML5 DnD). */
export async function dragCardToLane(page, taskId, laneKey) {
  await page.evaluate(
    (id, lane) => {
      const card = document.querySelector(`.card[data-id="${id}"]`);
      const target = document.querySelector(`.lane[data-tab="${lane}"]`);
      if (!card || !target) throw new Error(`card or lane missing: ${id} → ${lane}`);
      const dt = new DataTransfer();
      dt.setData("text/plain", id);
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    taskId,
    laneKey,
  );
}

export function makeTask(partial) {
  const now = new Date().toISOString();
  return {
    id: partial.id,
    title: partial.title || partial.id,
    kind: partial.kind || "pi",
    cwd: partial.cwd || "/tmp/agent-board-default",
    workspaceId: partial.workspaceId,
    prompt: partial.prompt || "hello",
    model: partial.model || "mock-model",
    iteration: partial.iteration || 1,
    status: partial.status || "draft",
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
    prompts: partial.prompts || [{ iteration: 1, prompt: partial.prompt || "hello", at: now }],
    summary: partial.summary,
    lastEvent: partial.lastEvent,
    endedAt: partial.endedAt,
  };
}
