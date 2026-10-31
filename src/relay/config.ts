import { RELAY_LIMITS } from "./limits.js";

const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RelayLogLevel = "info" | "warn" | "error";

export type DisabledRelayConfig = {
  enabled: false;
  level: RelayLogLevel;
  reason: string;
};

export type EnabledRelayConfig = {
  enabled: true;
  relayWsUrl: string;
  boardId: string;
  boardToken: string;
  boardLabel: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  openTimeoutMs: number;
  registerTimeoutMs: number;
};

export type RelayDialerConfig = DisabledRelayConfig | EnabledRelayConfig;

/**
 * Primary key wins when the key is present, even if the value is empty.
 * An empty primary does not fall through to the alias.
 */
function pick(env: NodeJS.ProcessEnv, primary: string, alias?: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, primary)) return env[primary];
  if (alias && Object.prototype.hasOwnProperty.call(env, alias)) return env[alias];
  return undefined;
}

function killSwitch(env: NodeJS.ProcessEnv): "off" | "on" | "unset" {
  if (!Object.prototype.hasOwnProperty.call(env, "RELAY_ENABLED")) return "unset";
  const raw = (env.RELAY_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") return "unset";
  if (raw === "0" || raw === "false" || raw === "off") return "off";
  if (raw === "1" || raw === "true" || raw === "on") return "on";
  return "on";
}

function hasAnyRelayEnv(env: NodeJS.ProcessEnv): boolean {
  const keys = [
    "RELAY_WS_URL",
    "AGENT_BOARD_RELAY_WS_URL",
    "BOARD_ID",
    "AGENT_BOARD_ID",
    "BOARD_TOKEN",
    "AGENT_BOARD_RELAY_TOKEN",
    "RELAY_ENABLED",
    "BOARD_LABEL",
    "RELAY_RECONNECT_MIN_MS",
    "RELAY_RECONNECT_MAX_MS",
    "RECONNECT_MIN_MS",
    "RECONNECT_MAX_MS",
  ];
  return keys.some((key) => Object.prototype.hasOwnProperty.call(env, key));
}

function parsePositiveMs(raw: string | undefined, fallback: number, label: string): number | string {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be a number greater than 0`;
  return n;
}

/**
 * Read dialer env. Never throws. Incomplete or invalid config disables the dialer.
 * The returned object is safe to log only after removing `boardToken` — callers must not print it.
 */
export function loadRelayDialerConfig(env: NodeJS.ProcessEnv = process.env): RelayDialerConfig {
  if (!hasAnyRelayEnv(env)) {
    return { enabled: false, level: "info", reason: "relay dialer skipped; relay env not set" };
  }

  const enabledFlag = killSwitch(env);
  if (enabledFlag === "off") {
    return { enabled: false, level: "info", reason: "relay dialer off (RELAY_ENABLED)" };
  }

  const relayRaw = pick(env, "RELAY_WS_URL", "AGENT_BOARD_RELAY_WS_URL");
  const boardIdRaw = pick(env, "BOARD_ID", "AGENT_BOARD_ID");
  const tokenRaw = pick(env, "BOARD_TOKEN", "AGENT_BOARD_RELAY_TOKEN");
  const labelRaw = pick(env, "BOARD_LABEL");
  const minRaw = pick(env, "RELAY_RECONNECT_MIN_MS", "RECONNECT_MIN_MS");
  const maxRaw = pick(env, "RELAY_RECONNECT_MAX_MS", "RECONNECT_MAX_MS");

  const relayWs = (relayRaw ?? "").trim();
  const boardId = (boardIdRaw ?? "").trim();
  const boardToken = (tokenRaw ?? "").trim();

  const missing: string[] = [];
  if (!relayWs) missing.push("RELAY_WS_URL");
  if (!boardId) missing.push("BOARD_ID");
  if (!boardToken) missing.push("BOARD_TOKEN");
  if (missing.length) {
    const reason = `relay dialer skipped; missing ${missing.join(", ")}`;
    return {
      enabled: false,
      level: enabledFlag === "on" ? "warn" : "info",
      reason,
    };
  }

  let url: URL;
  try {
    url = new URL(relayWs);
  } catch {
    return { enabled: false, level: "error", reason: "relay dialer skipped; RELAY_WS_URL is not a valid URL" };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return {
      enabled: false,
      level: "error",
      reason: "relay dialer skipped; RELAY_WS_URL must use ws:// or wss://",
    };
  }
  if (url.username || url.password) {
    return {
      enabled: false,
      level: "error",
      reason: "relay dialer skipped; RELAY_WS_URL must not include credentials",
    };
  }
  if (!BOARD_ID.test(boardId)) {
    return {
      enabled: false,
      level: "error",
      reason: "relay dialer skipped; BOARD_ID must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    };
  }

  const minParsed = parsePositiveMs(minRaw, 500, "RELAY_RECONNECT_MIN_MS");
  if (typeof minParsed === "string") {
    return { enabled: false, level: "error", reason: `relay dialer skipped; ${minParsed}` };
  }
  const maxParsed = parsePositiveMs(maxRaw, 15_000, "RELAY_RECONNECT_MAX_MS");
  if (typeof maxParsed === "string") {
    return { enabled: false, level: "error", reason: `relay dialer skipped; ${maxParsed}` };
  }
  if (maxParsed < minParsed) {
    return {
      enabled: false,
      level: "error",
      reason: "relay dialer skipped; RELAY_RECONNECT_MAX_MS must be >= RELAY_RECONNECT_MIN_MS",
    };
  }

  const boardLabel = (labelRaw ?? "").trim() || "ThinkBook";
  return {
    enabled: true,
    relayWsUrl: url.toString(),
    boardId,
    boardToken,
    boardLabel,
    reconnectMinMs: minParsed,
    reconnectMaxMs: maxParsed,
    openTimeoutMs: RELAY_LIMITS.openTimeoutMs,
    registerTimeoutMs: RELAY_LIMITS.registerTimeoutMs,
  };
}
