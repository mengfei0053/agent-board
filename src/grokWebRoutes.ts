import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { getGrokBotSettings, parseGrokTeamId } from "./grokBot.js";
import { grokWebAuth } from "./grokWebAuth.js";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const localPeers = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// These operations authorize the board service account, not the current browser.
// Never infer local access from X-Forwarded-For or an unverified Host header alone.
export function grokWebRoutes(auth = grokWebAuth) {
  const routes = new Hono<{ Bindings: HttpBindings }>();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const headers = c.req.raw.headers;
    const url = URL.parse(c.req.url);
    const peer = c.env?.incoming?.socket?.remoteAddress;
    const origin = headers.get("origin");
    if (!url || !peer || !localPeers.has(peer) || !localHosts.has(url.hostname) || headers.get("host") !== url.host ||
        headers.get("x-board-local") !== "1" ||
        (origin !== null && origin !== url.origin) || (c.req.method === "POST" && origin !== url.origin) ||
        (headers.has("sec-fetch-site") && headers.get("sec-fetch-site") !== "same-origin") ||
        [...headers.keys()].some(k => k === "forwarded" || k === "x-real-ip" || k.startsWith("x-forwarded-"))) {
      return c.json({ error: "请从看板服务器本机的 localhost 设置页管理 Cursor 登录。" }, 403);
    }
    await next();
  });
  routes.get("/login", c => c.json(auth.status()));
  routes.post("/login", async c => {
    if (c.req.header("content-type")?.split(";")[0].trim() !== "application/json") {
      return c.json({ error: "Expected application/json" }, 415);
    }
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
      return c.json({ error: "Login takes no parameters" }, 400);
    }
    try { return c.json(auth.start()); }
    catch { return c.json({ error: "无法启动 Cursor 登录。" }, 503); }
  });
  routes.get("/deployments", async c => {
    const input = c.req.query("teamId");
    let teamId: string | undefined;
    try { teamId = input === undefined ? getGrokBotSettings().teamId : parseGrokTeamId(input); }
    catch { return c.json({ error: "Team ID 必须是有效的十进制正整数。" }, 400); }
    try { return c.json({ slugs: await auth.deployments(teamId) }); }
    catch { return c.json({ error: "无法读取部署，请确认服务器的 Cursor 登录状态和团队权限。" }, 502); }
  });
  return routes;
}
