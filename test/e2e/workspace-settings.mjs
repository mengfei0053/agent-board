/**
 * E2E: workspace context menu + space settings page.
 * Spins a mock API + static file server (no Postgres required).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = join(root, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** @type {{ id: string, name: string, path: string, createdAt: string, updatedAt: string, settings?: object }} */
let workspace = {
  id: "ws_e2e_1",
  name: "E2E 工作区",
  path: "/tmp/agent-board-e2e",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  settings: undefined,
};

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  if (rel === "/workspaces/ws_e2e_1/settings" || /^\/workspaces\/[^/]+\/settings\/?$/.test(rel)) {
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

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const { pathname } = u;

    if (pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const hello = {
        type: "hello",
        tasks: [],
        workspaces: [workspace],
      };
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      // keep open briefly; client may reconnect
      const iv = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 15000);
      req.on("close", () => clearInterval(iv));
      return;
    }

    if (pathname === "/api/workspaces" && req.method === "GET") {
      return json(res, 200, {
        workspaces: [workspace],
        defaultWorkspaceId: workspace.id,
      });
    }

    if (pathname === "/api/tasks" && req.method === "GET") {
      return json(res, 200, { tasks: [], workspaceId: workspace.id });
    }

    const one = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (req.method === "GET") {
        if (id !== workspace.id) return json(res, 404, { error: "not found" });
        return json(res, 200, { workspace, defaultWorkspaceId: workspace.id });
      }
      if (req.method === "PATCH") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (id !== workspace.id) return json(res, 404, { error: "not found" });
        if (typeof body.name === "string" && body.name.trim()) workspace.name = body.name.trim();
        if (typeof body.path === "string" && body.path.trim()) workspace.path = body.path.trim();
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
          workspace.settings = Object.keys(next).length ? next : undefined;
        }
        workspace.updatedAt = new Date().toISOString();
        return json(res, 200, { workspace });
      }
      if (req.method === "DELETE") {
        return json(res, 400, { error: "e2e mock refuses delete" });
      }
    }

    const gitStatus = pathname.match(/^\/api\/workspaces\/([^/]+)\/git-status$/);
    if (gitStatus && req.method === "GET") {
      const id = decodeURIComponent(gitStatus[1]);
      if (id !== workspace.id) return json(res, 404, { error: "not found" });
      return json(res, 200, {
        workspaceId: id,
        root: workspace.path,
        truncated: false,
        scannedDirs: 2,
        cached: false,
        caps: { maxDepth: 6, maxRepos: 32, maxDirs: 4000, maxFilesPerRepo: 200 },
        repos: [
          {
            path: workspace.path,
            relPath: ".",
            branch: "main",
            detached: false,
            upstream: "origin/main",
            ahead: 1,
            behind: 0,
            upstreamGone: false,
            dirty: true,
            head: "abc1234",
            subject: "演示提交",
            noCommits: false,
            fileCount: 2,
            filesTruncated: false,
            error: null,
            files: [
              { code: " M", x: " ", y: "M", path: "README.md", label: "未暂存修改" },
              { code: "??", x: "?", y: "?", path: "notes.txt", label: "未跟踪" },
            ],
          },
        ],
      });
    }

    if (pathname.startsWith("/api/")) {
      return json(res, 404, { error: `mock missing ${pathname}` });
    }

    serveStatic(req, res, pathname);
  });
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log(`[e2e] mock server ${base}`);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);

    // —— Board: context menu ——
    await page.goto(base + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector(".ws-item");

    const menuItems = await page.evaluate(() => {
      const item = document.querySelector(".ws-item");
      if (!item) return null;
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
      if (!menu || menu.classList.contains("hidden")) return { open: false };
      return {
        open: true,
        actions: [...menu.querySelectorAll("[data-action]")].map((b) =>
          b.getAttribute("data-action"),
        ),
        labels: [...menu.querySelectorAll("[data-action]")].map((b) =>
          (b.textContent || "").trim(),
        ),
      };
    });

    assert.ok(menuItems?.open, "context menu should open");
    assert.deepEqual(menuItems.actions, ["settings", "edit", "delete"]);
    assert.ok(menuItems.labels.includes("设置"));
    assert.ok(menuItems.labels.includes("删除"));
    await page.waitForFunction(
      () => (document.getElementById("git-panel-summary")?.textContent || "").includes("有变更"),
    );
    const boardGit = await page.evaluate(() => ({
      hidden: document.getElementById("git-panel")?.hidden,
      summary: document.getElementById("git-panel-summary")?.textContent || "",
      body: document.getElementById("git-panel-body")?.textContent || "",
    }));
    assert.equal(boardGit.hidden, false);
    assert.match(boardGit.summary, /1 个仓库/);
    assert.match(boardGit.body, /main/);
    assert.match(boardGit.body, /README\.md/);
    assert.match(boardGit.body, /未跟踪/);
    assert.match(boardGit.body, /领先 1/);
    console.log("[e2e] board git panel ok");
    console.log("[e2e] context menu ok");

    // Click 设置 → settings page
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.evaluate(() => {
        document.querySelector('[data-action="settings"]')?.click();
      }),
    ]);
    assert.match(page.url(), /\/workspaces\/ws_e2e_1\/settings/);
    await page.waitForSelector("#ws-settings-form");
    console.log("[e2e] navigated to settings page");

    // —— Settings page load + save ——
    await page.waitForFunction(
      () => document.getElementById("ws-name")?.value === "E2E 工作区",
    );

    await page.click("#ws-system-prompt", { clickCount: 3 });
    await page.type("#ws-system-prompt", "本空间用 pnpm");
    await page.click("#ws-skills", { clickCount: 3 });
    await page.type("#ws-skills", "code-review\nrelease");
    await page.click("#ws-mcp", { clickCount: 3 });
    await page.type("#ws-mcp", '{"mcpServers":{"demo":{}}}');

    await page.click("#btn-save-ws-settings");
    await page.waitForFunction(
      () => (document.getElementById("ws-settings-status")?.textContent || "").includes("已保存"),
    );

    assert.equal(workspace.settings?.systemPrompt, "本空间用 pnpm");
    assert.deepEqual(workspace.settings?.skills, ["code-review", "release"]);
    assert.equal(workspace.settings?.mcp, '{"mcpServers":{"demo":{}}}');
    console.log("[e2e] settings save ok");

    // reload persists via mock memory
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForFunction(
      () => document.getElementById("ws-system-prompt")?.value.includes("pnpm"),
    );
    const skillsVal = await page.$eval("#ws-skills", (el) => el.value);
    assert.match(skillsVal, /code-review/);
    assert.match(skillsVal, /release/);
    console.log("[e2e] settings reload ok");

    await page.waitForFunction(
      () => (document.getElementById("git-status-summary")?.textContent || "").includes("有变更"),
    );
    const settingsGit = await page.$eval("#git-status-body", (el) => el.textContent || "");
    assert.match(settingsGit, /演示提交/);
    assert.match(settingsGit, /notes\.txt/);
    assert.match(settingsGit, /未暂存修改/);
    console.log("[e2e] settings git status ok");

    console.log("[e2e] all passed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("[e2e] failed:", err);
  process.exit(1);
});
