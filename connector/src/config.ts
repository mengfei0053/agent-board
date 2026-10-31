export type ConnectorConfig = {
  relayWsUrl: string;
  boardId: string;
  boardToken: string;
  boardBaseUrl: string;
  label: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  httpTimeoutMs: number;
};

export type ConfigResult = { ok: true; config: ConnectorConfig } | { ok: false; message: string };

const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function loadConnectorConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const relayWsUrl = (env.RELAY_WS_URL ?? "").trim();
  if (!relayWsUrl.startsWith("ws://") && !relayWsUrl.startsWith("wss://")) {
    return { ok: false, message: "RELAY_WS_URL must be a ws:// or wss:// URL" };
  }
  const boardId = (env.BOARD_ID ?? "").trim();
  if (!BOARD_ID.test(boardId)) return { ok: false, message: "BOARD_ID is missing or invalid" };
  const boardToken = (env.BOARD_TOKEN ?? "").trim();
  if (!boardToken) return { ok: false, message: "BOARD_TOKEN is required" };
  const boardBase = (env.BOARD_BASE_URL ?? "http://127.0.0.1:8791").trim();
  const checked = assertLoopbackHttp(boardBase);
  if (!checked.ok) return checked;
  const reconnectMinMs = parseMs(env.RECONNECT_MIN_MS, 500);
  const reconnectMaxMs = parseMs(env.RECONNECT_MAX_MS, 15_000);
  const httpTimeoutMs = parseMs(env.HTTP_TIMEOUT_MS, 15_000);
  if (reconnectMinMs === null || reconnectMaxMs === null || httpTimeoutMs === null) {
    return { ok: false, message: "reconnect and HTTP timeouts must be positive integers" };
  }
  return {
    ok: true,
    config: {
      relayWsUrl,
      boardId,
      boardToken,
      boardBaseUrl: checked.url,
      label: (env.BOARD_LABEL ?? "ThinkBook").trim() || "ThinkBook",
      reconnectMinMs,
      reconnectMaxMs: Math.max(reconnectMinMs, reconnectMaxMs),
      httpTimeoutMs,
    },
  };
}

export function assertLoopbackHttp(value: string): { ok: true; url: string } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: "BOARD_BASE_URL is not a URL" };
  }
  if (parsed.protocol !== "http:") return { ok: false, message: "BOARD_BASE_URL must be http on loopback" };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return { ok: false, message: "BOARD_BASE_URL must stay on loopback" };
  }
  return { ok: true, url: parsed.toString().replace(/\/$/, "") };
}

function parseMs(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
