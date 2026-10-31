import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { AuthStore } from "./auth.js";
import { RelayHub, type BoardConn, type PhoneConn } from "./hub.js";
import { log as defaultLog, type LogFields } from "./log.js";
import { makeErr, PROTOCOL_VERSION, type Envelope } from "./protocol.js";
import { RateLimiter } from "./rate-limit.js";

type LogFn = (level: "info" | "warn" | "error", message: string, fields?: LogFields) => void;

export type ServerOptions = {
  host?: string;
  port?: number;
  adminToken: string;
  boardToken: string;
  tokenTtlMs?: number;
  pairTtlMs?: number;
  cmdTimeoutMs?: number;
  idempotencyTtlMs?: number;
  pairAttemptLimit?: number;
  pairWindowMs?: number;
  wsMessagesPerSec?: number;
  now?: () => number;
  log?: LogFn;
  maxConnections?: number;
};

export type StartedServer = {
  host: string;
  port: number;
  httpUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
};

const MAX_BODY = 64 * 1024;
const MAX_FRAME = 256 * 1024;

export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const writeLog = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const auth = new AuthStore({
    adminToken: options.adminToken,
    boardToken: options.boardToken,
    tokenTtlMs: options.tokenTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    pairTtlMs: options.pairTtlMs ?? 300_000,
    pairAttemptLimit: options.pairAttemptLimit,
    pairWindowMs: options.pairWindowMs,
    now,
  });
  const hub = new RelayHub(auth, {
    cmdTimeoutMs: options.cmdTimeoutMs ?? 8_000,
    idempotencyTtlMs: options.idempotencyTtlMs,
    now,
    log: writeLog,
  });
  const startedAt = Date.now();
  const sockets = new Set<WebSocket>();
  const maxConnections = options.maxConnections ?? 200;
  const wsLimit = options.wsMessagesPerSec ?? 40;
  const adminLimiter = new RateLimiter(60, 60_000, now);

  const server = createServer((req, res) => {
    void handleHttp(req, res, { auth, hub, startedAt, log: writeLog, adminLimiter, now }).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal";
      const message = status === 500 ? "internal error" : error instanceof Error ? error.message : "internal error";
      if (status === 500) writeLog("error", "http handler failed", { message: error instanceof Error ? error.message : "unknown" });
      if (!res.headersSent) sendJson(res, status, { error: { code, message } });
      else res.end();
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;

  const wss = new WebSocketServer({ server, path: "/v1/ws", maxPayload: MAX_FRAME, perMessageDeflate: false });

  wss.on("connection", (socket) => {
    if (sockets.size >= maxConnections) {
      socket.close(1013, "overloaded");
      return;
    }
    sockets.add(socket);
    const limiter = new RateLimiter(wsLimit, 1_000, now);
    let role: "unknown" | "board" | "phone" = "unknown";
    let board: BoardConn | null = null;
    let phone: PhoneConn | null = null;

    const send = (message: Envelope) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const closeSocket = () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    };

    socket.on("message", (data, isBinary) => {
      try {
        if (!limiter.allow("ws")) {
          send(makeErr(now(), "websocket message rate exceeded", { code: "rate_limited" }));
          return;
        }
        if (isBinary) {
          send(makeErr(now(), "binary frames are not accepted", { code: "bad_request" }));
          return;
        }
        const text = rawToString(data);
        if (role === "unknown") {
          const opened = openRole(text, send, closeSocket);
          role = opened.role;
          board = opened.board;
          phone = opened.phone;
          return;
        }
        if (role === "board" && board) hub.handleBoard(board, text);
        if (role === "phone" && phone) hub.handlePhone(phone, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : "internal error";
        writeLog("error", "websocket handler failed", { message });
        send(makeErr(now(), "internal error", { code: "internal" }));
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      if (board) hub.disconnectBoard(board);
      if (phone) hub.disconnectPhone(phone);
    });
    socket.on("error", () => {
      socket.close();
    });

    function openRole(text: string, sendFrame: (message: Envelope) => void, close: () => void): {
      role: "unknown" | "board" | "phone";
      board: BoardConn | null;
      phone: PhoneConn | null;
    } {
      let peeked: unknown;
      try {
        peeked = JSON.parse(text) as unknown;
      } catch {
        sendFrame(makeErr(now(), "invalid JSON", { code: "bad_request" }));
        return { role: "unknown", board: null, phone: null };
      }
      const type = isRecord(peeked) ? peeked.type : undefined;
      const ref = isRecord(peeked) && typeof peeked.id === "string" ? peeked.id : undefined;
      if (type === "board.register") {
        const next = hub.attachBoard(sendFrame, close);
        hub.handleBoard(next, peeked);
        return { role: "board", board: next, phone: null };
      }
      if (type === "client.hello") {
        const next = hub.attachPhone(sendFrame, close);
        hub.handlePhone(next, peeked);
        return { role: "phone", board: null, phone: next };
      }
      sendFrame(makeErr(now(), "send board.register or client.hello first", { code: "unauthorized", ref }));
      return { role: "unknown", board: null, phone: null };
    }
  });

  const ping = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, 30_000);
  ping.unref?.();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server, wss, sockets, hub, ping);
    throw new Error("server did not bind a TCP port");
  }
  const clientHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    host,
    port: address.port,
    httpUrl: `http://${clientHost}:${address.port}`,
    wsUrl: `ws://${clientHost}:${address.port}/v1/ws`,
    close: () => closeServer(server, wss, sockets, hub, ping),
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { auth: AuthStore; hub: RelayHub; startedAt: number; log: LogFn; adminLimiter: RateLimiter; now: () => number },
): Promise<void> {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = new URL(req.url ?? "/", "http://relay.local");
  const path = url.pathname;
  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "agent-board-relay",
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      ...ctx.hub.stats(),
    });
    return;
  }

  if (path === "/auth/pair/create" || path === "/auth/revoke/device" || path === "/auth/revoke/board" || path === "/auth/board/issue") {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.adminLimiter.allow(clientIp(req))) {
      sendJson(res, 429, { error: { code: "rate_limited", message: "too many admin requests" } });
      return;
    }
    if (!ctx.auth.verifyAdmin(bearer(req))) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "admin token rejected" } });
      return;
    }
    const body = await readJson(req);
    if (!isRecord(body)) throw new HttpError(400, "bad_request", "JSON object required");
    if (path === "/auth/pair/create") return createPair(res, ctx, body);
    if (path === "/auth/revoke/device") return revokeDevice(res, ctx, body);
    if (path === "/auth/revoke/board") return revokeBoard(res, ctx, body);
    return issueBoard(res, ctx, body);
  }

  if (path === "/auth/pair") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    if (!isRecord(body) || typeof body.pairCode !== "string") {
      sendJson(res, 400, { error: { code: "bad_request", message: "pairCode is required" } });
      return;
    }
    if (body.deviceName !== undefined && typeof body.deviceName !== "string") {
      sendJson(res, 400, { error: { code: "bad_request", message: "deviceName must be a string" } });
      return;
    }
    const paired = ctx.auth.pair(body.pairCode, typeof body.deviceName === "string" ? body.deviceName : undefined, clientIp(req));
    if (!paired.ok) return sendAuthFailure(res, paired.code, paired.message);
    sendJson(res, 200, {
      deviceId: paired.deviceId,
      deviceToken: paired.deviceToken,
      role: paired.role,
      boardIds: paired.boardIds,
      expiresAt: paired.expiresAt,
    });
    return;
  }

  if (path === "/auth/refresh") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    if (!isRecord(body) || typeof body.deviceToken !== "string") {
      sendJson(res, 400, { error: { code: "bad_request", message: "deviceToken is required" } });
      return;
    }
    const refreshed = ctx.auth.refresh(body.deviceToken);
    if (!refreshed.ok) return sendAuthFailure(res, refreshed.code, refreshed.message);
    ctx.hub.kickToken(body.deviceToken);
    sendJson(res, 200, {
      deviceId: refreshed.deviceId,
      deviceToken: refreshed.deviceToken,
      role: refreshed.role,
      boardIds: refreshed.boardIds,
      expiresAt: refreshed.expiresAt,
    });
    return;
  }

  sendJson(res, 404, { error: { code: "not_found", message: "not found" } });
}

function createPair(res: ServerResponse, ctx: { auth: AuthStore }, body: Record<string, unknown>): void {
  if (!Array.isArray(body.boardIds) || body.boardIds.some((id) => typeof id !== "string")) {
    sendJson(res, 400, { error: { code: "bad_request", message: "boardIds must be an array of strings" } });
    return;
  }
  let ttlMs: number | undefined;
  if (body.ttlMs !== undefined) {
    if (typeof body.ttlMs !== "number") {
      sendJson(res, 400, { error: { code: "bad_request", message: "ttlMs must be a number" } });
      return;
    }
    ttlMs = body.ttlMs;
  }
  const created = ctx.auth.createPairCode(body.boardIds as string[], ttlMs);
  if (!created.ok) return sendAuthFailure(res, created.code, created.message);
  sendJson(res, 200, { pairCode: created.pairCode, boardIds: created.boardIds, expiresAt: created.expiresAt });
}

function revokeDevice(res: ServerResponse, ctx: { auth: AuthStore; hub: RelayHub }, body: Record<string, unknown>): void {
  if (typeof body.deviceId !== "string") {
    sendJson(res, 400, { error: { code: "bad_request", message: "deviceId is required" } });
    return;
  }
  if (!ctx.auth.revokeDevice(body.deviceId)) {
    sendJson(res, 404, { error: { code: "not_found", message: "device not found" } });
    return;
  }
  ctx.hub.kickDevice(body.deviceId);
  sendJson(res, 200, { ok: true, deviceId: body.deviceId });
}

function revokeBoard(res: ServerResponse, ctx: { auth: AuthStore; hub: RelayHub }, body: Record<string, unknown>): void {
  if (typeof body.boardToken === "string") {
    const credentialId = ctx.auth.revokeBoardToken(body.boardToken);
    if (!credentialId) {
      sendJson(res, 404, { error: { code: "not_found", message: "board token not found" } });
      return;
    }
    ctx.hub.kickCredential(credentialId);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (typeof body.boardId === "string") {
    const revoked = ctx.auth.revokeBoardId(body.boardId);
    if (!revoked.ok) {
      sendJson(res, 400, { error: { code: "bad_request", message: "boardId is invalid" } });
      return;
    }
    for (const credentialId of revoked.credentialIds) ctx.hub.kickCredential(credentialId);
    ctx.hub.kickBoard(body.boardId);
    sendJson(res, 200, { ok: true, boardId: body.boardId });
    return;
  }
  sendJson(res, 400, { error: { code: "bad_request", message: "boardToken or boardId is required" } });
}

function issueBoard(res: ServerResponse, ctx: { auth: AuthStore; hub: RelayHub }, body: Record<string, unknown>): void {
  if (!Array.isArray(body.boardIds) || body.boardIds.some((id) => typeof id !== "string")) {
    sendJson(res, 400, { error: { code: "bad_request", message: "boardIds must be an array of strings" } });
    return;
  }
  const issued = ctx.auth.issueBoardToken(body.boardIds as string[]);
  if (!issued.ok) return sendAuthFailure(res, issued.code, issued.message);
  for (const credentialId of issued.revokedCredentialIds) ctx.hub.kickCredential(credentialId);
  sendJson(res, 200, { boardToken: issued.boardToken, boardIds: issued.boardIds });
}

function sendAuthFailure(res: ServerResponse, code: string, message: string): void {
  const status = code === "unauthorized" ? 401 : code === "rate_limited" ? 429 : code === "not_found" ? 404 : 400;
  sendJson(res, status, { error: { code, message } });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, "payload_too_large", "body too large");
    chunks.push(buf);
  }
  if (size === 0) throw new HttpError(400, "bad_request", "JSON body required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "bad_request", "invalid JSON");
  }
}

function methodNotAllowed(res: ServerResponse): void {
  res.setHeader("allow", "POST");
  sendJson(res, 405, { error: { code: "method_not_allowed", message: "method not allowed" } });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = status === 204 ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function closeServer(
  server: HttpServer,
  wss: WebSocketServer,
  sockets: Set<WebSocket>,
  hub: RelayHub,
  ping: NodeJS.Timeout,
): Promise<void> {
  clearInterval(ping);
  hub.dispose();
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
