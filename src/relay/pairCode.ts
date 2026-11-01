import { loadRelayDialerConfig } from "./config.js";

export async function createBoardPairCode(adminToken: string, env: NodeJS.ProcessEnv = process.env) {
  const config = loadRelayDialerConfig(env);
  if (!config.enabled) throw new Error("请先配置并启用看板中继连接。");
  if (!adminToken.trim() || /[\r\n]/.test(adminToken)) throw new Error("请输入有效的中继管理员令牌。");
  const url = new URL(config.relayWsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/auth/pair/create";
  url.search = "";
  url.hash = "";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ boardIds: [config.boardId] }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("无法连接中继，请检查中继配置和网络。");
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error("中继管理员令牌无效。");
    if (response.status === 429) throw new Error("请求过于频繁，请稍后重试。");
    throw new Error("中继无法生成配对码，请稍后重试。");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || !("pairCode" in body) || typeof body.pairCode !== "string" || !/^pc_[A-Za-z0-9_-]{43}$/.test(body.pairCode) || !("expiresAt" in body) || typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt)) {
    throw new Error("中继返回了无效的配对码响应。");
  }
  return { pairCode: body.pairCode, expiresAt: body.expiresAt, boardId: config.boardId };
}
