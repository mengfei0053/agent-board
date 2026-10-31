import { generateAdminToken, generateBoardToken } from "./auth.js";

export type AppConfig = {
  host: string;
  port: number;
  adminToken: string;
  boardToken: string;
  tokenTtlMs: number;
  pairTtlMs: number;
  cmdTimeoutMs: number;
  idempotencyTtlMs: number;
  pairAttemptLimit: number;
  pairWindowMs: number;
  wsMessagesPerSec: number;
  generatedAdminToken: boolean;
  generatedBoardToken: boolean;
};

export type LoadConfigResult =
  | { ok: true; config: AppConfig; warnings: string[] }
  | { ok: false; message: string };

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadConfig(env: NodeJS.ProcessEnv): LoadConfigResult {
  const host = (env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  if (/\s/.test(host)) return { ok: false, message: "HOST must not contain whitespace" };

  const port = parsePort(env.PORT ?? "8787");
  if (port === null) return { ok: false, message: "PORT must be an integer from 1 to 65535" };

  const tokenTtlMs = parsePositiveInt(env.TOKEN_TTL_MS, 7 * DAY_MS);
  if (tokenTtlMs === null) return { ok: false, message: "TOKEN_TTL_MS must be a positive integer" };

  const pairFromMs = env.PAIR_TTL_MS?.trim() ? env.PAIR_TTL_MS : env.PAIR_TTL;
  const pairTtlMs = parsePositiveInt(pairFromMs, 300_000);
  if (pairTtlMs === null || pairTtlMs < 1_000) return { ok: false, message: "PAIR_TTL_MS must be an integer of at least 1000" };

  const cmdTimeoutMs = parsePositiveInt(env.CMD_TIMEOUT_MS, 8_000);
  if (cmdTimeoutMs === null) return { ok: false, message: "CMD_TIMEOUT_MS must be a positive integer" };

  const idempotencyTtlMs = parsePositiveInt(env.IDEMPOTENCY_TTL_MS, 600_000);
  if (idempotencyTtlMs === null) return { ok: false, message: "IDEMPOTENCY_TTL_MS must be a positive integer" };
  if (idempotencyTtlMs < cmdTimeoutMs) {
    return { ok: false, message: "IDEMPOTENCY_TTL_MS must be greater than or equal to CMD_TIMEOUT_MS" };
  }

  const pairAttemptLimit = parsePositiveInt(env.PAIR_ATTEMPT_LIMIT, 8);
  if (pairAttemptLimit === null) return { ok: false, message: "PAIR_ATTEMPT_LIMIT must be a positive integer" };

  const pairWindowMs = parsePositiveInt(env.PAIR_WINDOW_MS, 60_000);
  if (pairWindowMs === null) return { ok: false, message: "PAIR_WINDOW_MS must be a positive integer" };

  const wsMessagesPerSec = parsePositiveInt(env.WS_MESSAGES_PER_SEC, 40);
  if (wsMessagesPerSec === null) return { ok: false, message: "WS_MESSAGES_PER_SEC must be a positive integer" };

  const production = env.NODE_ENV === "production";
  const adminFromEnv = env.ADMIN_TOKEN?.trim() ?? "";
  const boardFromEnv = env.BOARD_TOKEN?.trim() ?? "";
  if (production && !adminFromEnv) return { ok: false, message: "ADMIN_TOKEN is required when NODE_ENV=production" };
  if (production && !boardFromEnv) return { ok: false, message: "BOARD_TOKEN is required when NODE_ENV=production" };

  const warnings: string[] = [];
  const adminToken = adminFromEnv || generateAdminToken();
  const boardToken = boardFromEnv || generateBoardToken();
  if (adminToken.length < 16) warnings.push("ADMIN_TOKEN is shorter than 16 characters");
  if (boardToken.length < 16) warnings.push("BOARD_TOKEN is shorter than 16 characters");

  return {
    ok: true,
    warnings,
    config: {
      host,
      port,
      adminToken,
      boardToken,
      tokenTtlMs,
      pairTtlMs,
      cmdTimeoutMs,
      idempotencyTtlMs,
      pairAttemptLimit,
      pairWindowMs,
      wsMessagesPerSec,
      generatedAdminToken: !adminFromEnv,
      generatedBoardToken: !boardFromEnv,
    },
  };
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  if (port < 1 || port > 65535) return null;
  return port;
}

function parsePositiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
