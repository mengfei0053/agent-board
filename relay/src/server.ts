import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PRE_STORE_CODES,
  encode,
  frame,
  parseEnvelope,
  text,
  validBoardId,
  validKey,
  validateCreate,
  type Envelope,
} from "./protocol.js";
import { RelayStore, type BoardRecord, type Device, type StoredCommand } from "./store.js";

const MAX_FRAME = 256 * 1024;

export type RelayServer = {
  port: number;
  close: () => Promise<void>;
  store: RelayStore;
};

type Phone = { ws: WebSocket; device: Device; boards: Set<string>; logs: Set<string> };
type Connector = { ws: WebSocket; board: BoardRecord };

export function startRelay(opts: { port?: number; setupToken: string; now?: () => number }): Promise<RelayServer> {
  const store = new RelayStore(opts.now);
  const phones = new Set<Phone>();
  const connectors = new Map<string, Connector>();

  const http = createServer((req, res) => {
    void handleHttp(req, res, store, opts.setupToken).catch(() => sendJson(res, 500, { error: { code: "bad_request", message: "failed" } }));
  });
  const wss = new WebSocketServer({ server: http, path: "/v1/ws", maxPayload: MAX_FRAME });

  wss.on("connection", (ws) => {
    let phone: Phone | undefined;
    let connector: Connector | undefined;
    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      if (raw.length > MAX_FRAME) {
        ws.close(1009, "frame too large");
        return;
      }
      let message: Envelope;
      try {
        message = parseEnvelope(raw);
      } catch (err) {
        send(ws, frame("err", { code: "bad_request", message: err instanceof Error ? err.message : "bad frame" }));
        return;
      }
      store.note(message.type, message.id, text(message.payload, "boardId"));
      if (!phone && !connector) {
        if (message.type === "client.hello") {
          const device = store.deviceByToken(text(message.payload, "token") ?? "");
          if (!device) {
            send(ws, frame("err", { code: "unauthorized", message: "device token rejected" }, message.id));
            ws.close(4001, "unauthorized");
            return;
          }
          phone = { ws, device, boards: new Set(), logs: new Set() };
          phones.add(phone);
          send(ws, frame("ack", { stage: "executed" }, message.id));
          return;
        }
        if (message.type === "board.register") {
          const board = store.boardByToken(text(message.payload, "token") ?? "");
          const boardId = text(message.payload, "boardId") ?? "";
          if (!board || board.boardId !== boardId) {
            send(ws, frame("err", { code: "unauthorized", message: "board token rejected" }, message.id));
            ws.close(4001, "unauthorized");
            return;
          }
          connectors.get(boardId)?.ws.close(4000, "replaced");
          connector = { ws, board };
          connectors.set(boardId, connector);
          store.onlineBoards.add(boardId);
          send(ws, frame("ack", { stage: "executed" }, message.id));
          return;
        }
        send(ws, frame("err", { code: "unauthorized", message: "hello required" }, message.id));
        return;
      }
      if (phone) handlePhone(phone, message);
      else if (connector) handleConnector(connector, message);
    });
    ws.on("close", () => {
      if (phone) phones.delete(phone);
      if (connector && connectors.get(connector.board.boardId)?.ws === ws) {
        connectors.delete(connector.board.boardId);
        store.onlineBoards.delete(connector.board.boardId);
      }
    });
  });

  function handlePhone(phone: Phone, message: Envelope) {
    const payload = message.payload;
    if (message.type === "board.list") {
      const boards = phone.device.boardIds.map((boardId) => ({
        boardId,
        label: boardLabel(store, boardId),
        online: connectors.has(boardId),
        generation: null,
      }));
      send(phone.ws, frame("ack", { boards }, message.id));
      return;
    }
    const boardId = text(payload, "boardId") ?? "";
    if (!phone.device.boardIds.includes(boardId)) {
      send(phone.ws, frame("err", { code: "forbidden", message: "board is not paired to this phone" }, message.id));
      return;
    }
    if (message.type === "sub.tasks") {
      phone.boards.add(boardId);
      send(phone.ws, frame("ack", { stage: "executed", boardId }, message.id));
      return;
    }
    if (message.type === "sub.logs") {
      const taskId = text(payload, "taskId");
      phone.logs.add(taskId ? `${boardId}/${taskId}` : boardId);
      send(phone.ws, frame("ack", { stage: "executed", boardId }, message.id));
      return;
    }
    if (message.type === "cmd.lookup") {
      const key = text(payload, "idempotencyKey") ?? "";
      const found = store.findCommand(boardId, key);
      send(phone.ws, frame("ack", found ? commandAck(found) : { stage: "unknown", boardId }, message.id));
      return;
    }
    if (message.type === "cmd.create" || message.type === "cmd.continue" || message.type === "cmd.stop") {
      handleCommand(phone, message);
      return;
    }
    send(phone.ws, frame("err", { code: "bad_request", message: "unsupported type" }, message.id));
  }

  function handleCommand(phone: Phone, message: Envelope) {
    const payload = message.payload;
    const boardId = text(payload, "boardId") ?? "";
    const key = text(payload, "idempotencyKey") ?? "";
    const invalid = message.type === "cmd.create" ? validateCreate(payload) : commandShapeError(message.type, payload);
    if (invalid) {
      send(phone.ws, frame("err", { code: "bad_request", message: invalid, boardId }, message.id));
      return;
    }
    if (!validKey(key)) {
      send(phone.ws, frame("err", { code: "bad_request", message: "idempotencyKey must be 8-80 visible ASCII characters", boardId }, message.id));
      return;
    }
    const prior = store.findCommand(boardId, key);
    if (prior) {
      send(phone.ws, frame(prior.stage === "failed" ? "err" : "ack", commandAck(prior), message.id));
      return;
    }
    if (!connectors.has(boardId)) {
      send(phone.ws, frame("err", { code: "board_offline", message: "This board is offline. The relay will not queue a command.", boardId }, message.id));
      return;
    }
    const stored: StoredCommand = {
      boardId,
      cmd: message.type,
      idempotencyKey: key,
      stage: "accepted",
      createdAt: Date.now(),
    };
    store.rememberCommand(stored);
    send(phone.ws, frame("ack", { stage: "accepted", boardId, idempotencyKey: key }, message.id));
    const connector = connectors.get(boardId);
    if (connector) send(connector.ws, frame(message.type, payload, message.id));
  }

  function handleConnector(connector: Connector, message: Envelope) {
    const boardId = connector.board.boardId;
    if (message.type === "cmd.result") {
      const key = text(message.payload, "idempotencyKey") ?? "";
      const stage = text(message.payload, "stage");
      const stored = store.findCommand(boardId, key);
      if (!stored || (stage !== "executed" && stage !== "failed" && stage !== "timeout")) {
        send(connector.ws, frame("err", { code: "bad_request", message: "unknown command result" }, message.id));
        return;
      }
      stored.stage = stage;
      stored.message = text(message.payload, "message");
      const task = message.payload.task;
      if (task && typeof task === "object") stored.task = task as Record<string, unknown>;
      for (const phone of phones) {
        if (!phone.device.boardIds.includes(boardId)) continue;
        send(phone.ws, frame(stage === "failed" ? "err" : "ack", commandAck(stored)));
      }
      return;
    }
    if (message.type.startsWith("evt.")) {
      const eventBoard = text(message.payload, "boardId") ?? boardId;
      if (eventBoard !== boardId) return;
      const taskId = text(message.payload, "taskId");
      for (const phone of phones) {
        if (!phone.device.boardIds.includes(boardId)) continue;
        const wantsTasks = phone.boards.has(boardId);
        const wantsLogs = phone.logs.has(boardId) || (taskId != null && phone.logs.has(`${boardId}/${taskId}`));
        const isLog = message.type === "evt.log";
        if (isLog ? wantsLogs : wantsTasks) send(phone.ws, message);
      }
    }
  }

  return new Promise((resolve) => {
    http.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = http.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        store,
        close: () =>
          new Promise((done) => {
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, store: RelayStore, setupToken: string) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, boardsOnline: store.onlineBoards.size });
    return;
  }
  const body = await readBody(req);
  if (req.method === "POST" && url.pathname === "/boards") {
    if (!authorized(req, setupToken)) return sendJson(res, 401, { error: { code: "unauthorized", message: "setup token required" } });
    const boardId = typeof body.boardId === "string" ? body.boardId : "";
    const label = typeof body.label === "string" ? body.label : boardId;
    if (!validBoardId(boardId)) return sendJson(res, 400, { error: { code: "bad_request", message: "boardId is invalid" } });
    const board = store.registerBoard(boardId, label);
    sendJson(res, 201, { boardId: board.boardId, label: board.label, boardToken: board.token });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/pair/create") {
    const token = bearer(req);
    const board = token ? store.boardByToken(token) : undefined;
    if (!board) return sendJson(res, 401, { error: { code: "unauthorized", message: "board token required" } });
    const pair = store.createPairCode(board.boardId);
    sendJson(res, 201, { pairCode: pair.code, boardId: pair.boardId, expiresAt: pair.expiresAt });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/pair") {
    const code = typeof body.pairCode === "string" ? body.pairCode : "";
    const name = typeof body.deviceName === "string" ? body.deviceName : "";
    const redeemed = store.redeemPairCode(code, name);
    if (!redeemed.ok) return sendJson(res, redeemed.status, { error: { code: "unauthorized", message: redeemed.error } });
    sendJson(res, 200, publicDevice(redeemed.device));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/refresh") {
    const token = typeof body.deviceToken === "string" ? body.deviceToken : "";
    const next = store.refresh(token);
    if (!next) return sendJson(res, 401, { error: { code: "revoked", message: "device token rejected" } });
    sendJson(res, 200, publicDevice(next));
    return;
  }
  sendJson(res, 404, { error: { code: "bad_request", message: "not found" } });
}

function commandShapeError(type: string, payload: Record<string, unknown>): string | null {
  const boardId = text(payload, "boardId") ?? "";
  const taskId = text(payload, "taskId") ?? "";
  if (!validBoardId(boardId)) return "boardId is invalid";
  if (!validBoardId(taskId)) return "taskId is invalid";
  if (type !== "cmd.continue" && type !== "cmd.stop") return "unsupported type";
  return null;
}

function commandAck(cmd: StoredCommand): Record<string, unknown> {
  return {
    stage: cmd.stage,
    boardId: cmd.boardId,
    idempotencyKey: cmd.idempotencyKey,
    cmd: cmd.cmd,
    message: cmd.message,
    task: cmd.task,
    code: cmd.stage === "failed" ? "failed" : undefined,
  };
}

function boardLabel(store: RelayStore, boardId: string): string {
  return [...store.boards.values()].find((b) => b.boardId === boardId)?.label ?? boardId;
}

function publicDevice(device: { deviceId: string; token: string; boardIds: string[]; expiresAt: number }) {
  return {
    deviceId: device.deviceId,
    deviceToken: device.token,
    role: "phone",
    boardIds: device.boardIds,
    expiresAt: device.expiresAt,
  };
}

function authorized(req: IncomingMessage, setupToken: string): boolean {
  return bearer(req) === setupToken && setupToken.length > 0;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

function send(ws: WebSocket, message: Envelope) {
  if (ws.readyState === ws.OPEN) ws.send(encode(message));
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

export { PRE_STORE_CODES };
