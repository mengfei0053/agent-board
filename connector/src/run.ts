import WebSocket from "ws";
import { BoardClient } from "./board.js";
import type { ConnectorConfig } from "./config.js";
import { ConnectorSession } from "./session.js";

export type ConnectorRunOptions = ConnectorConfig & {
  /** Runs after the register ack, before the session is built. Frames stay buffered. */
  beforeSession?: () => Promise<void>;
};

type Envelope = {
  v: 1;
  id: string;
  type: string;
  ts: number;
  payload?: Record<string, unknown>;
};

export type ConnectorHandle = {
  ready: Promise<void>;
  generation: () => number;
  /** Close the current relay socket so the loop registers again. */
  disconnect: () => void;
  close: () => Promise<void>;
};

export function startConnector(
  config: ConnectorRunOptions,
  log: (message: string, fields?: Record<string, string | number>) => void = () => {},
): ConnectorHandle {
  const api = new BoardClient(config.boardBaseUrl, config.httpTimeoutMs);
  let generation = 0;
  let socket: WebSocket | null = null;
  let stopped = false;
  let readySettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const loop = (async () => {
    let delay = config.reconnectMinMs;
    while (!stopped) {
      try {
        await runSession();
        delay = config.reconnectMinMs;
      } catch (error) {
        if (stopped) break;
        const message = error instanceof Error ? error.message : "session ended";
        log("connector session ended", { message, boardId: config.boardId });
        if (!readySettled) {
          readySettled = true;
          rejectReady(error instanceof Error ? error : new Error(message));
        }
        await sleep(delay);
        delay = Math.min(delay * 2, config.reconnectMaxMs);
      }
    }
  })();

  return {
    ready,
    generation: () => generation,
    disconnect: () => {
      socket?.close();
    },
    close: async () => {
      stopped = true;
      socket?.close();
      await loop.catch(() => undefined);
    },
  };

  async function runSession(): Promise<void> {
    const ws = new WebSocket(config.relayWsUrl);
    socket = ws;
    const abort = new AbortController();
    const pending: Envelope[] = [];
    let session: ConnectorSession | null = null;
    let failInbound: (error: unknown) => void = () => {};
    let notifyPending: () => void = () => {};
    const inbound = new Promise<void>((resolve, reject) => {
      failInbound = reject;
      ws.on("close", () => {
        abort.abort();
        resolve();
      });
    });
    ws.on("error", () => {
      ws.close();
    });
    ws.on("message", (data) => {
      const message = parseFrame(data);
      if (!message) return;
      if (!session) {
        pending.push(message);
        notifyPending();
        return;
      }
      void session.onMessage(message).catch(failInbound);
    });

    try {
      await opened(ws);
      const registerId = crypto.randomUUID();
      const registered = waitForPending(pending, (listener) => {
        notifyPending = listener;
      }, (message) => {
        return (message.type === "ack" || message.type === "err") && message.payload?.ref === registerId;
      }, ws);
      ws.send(JSON.stringify({
        v: 1,
        id: registerId,
        type: "board.register",
        ts: Date.now(),
        payload: {
          boardId: config.boardId,
          token: config.boardToken,
          label: config.label,
          capabilities: ["archive.list"],
        },
      }));
      const ack = await registered;
      if (ack.type !== "ack" || typeof ack.payload?.generation !== "number") {
        throw new Error("board register rejected");
      }
      generation = ack.payload.generation;
      log("board registered", { boardId: config.boardId, generation });
      if (config.beforeSession) await config.beforeSession();
      session = new ConnectorSession(config.boardId, api, (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      }, generation);
      const queued = pending.splice(0);
      for (const message of queued) {
        void session.onMessage(message).catch(failInbound);
      }

      let markOpen: () => void = () => {};
      const eventsOpen = new Promise<void>((resolve) => {
        markOpen = resolve;
      });
      const events = session.streamEvents(abort.signal, markOpen).catch((error: unknown) => {
        if (abort.signal.aborted) return;
        throw error;
      });
      await Promise.race([eventsOpen, events]);
      await session.onRegistered(generation);
      if (!readySettled) {
        readySettled = true;
        resolveReady();
      }
      await Promise.race([inbound, events]);
    } finally {
      abort.abort();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    if (!stopped) throw new Error("relay socket closed");
  }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const ok = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off("open", ok);
      socket.off("error", fail);
    };
    socket.on("open", ok);
    socket.on("error", fail);
  });
}

function waitForPending(
  pending: Envelope[],
  setNotify: (listener: () => void) => void,
  pred: (message: Envelope) => boolean,
  socket: WebSocket,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for board.register ack"));
    }, 8_000);
    const check = () => {
      const index = pending.findIndex(pred);
      if (index < 0) return;
      const message = pending.splice(index, 1)[0];
      if (!message) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("relay socket closed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      setNotify(() => {});
      socket.off("close", onClose);
    };
    setNotify(check);
    socket.on("close", onClose);
    check();
  });
}

function parseFrame(data: WebSocket.RawData): Envelope | null {
  try {
    const text = typeof data === "string" ? data : data.toString();
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 1 || typeof record.id !== "string" || typeof record.type !== "string" || typeof record.ts !== "number") {
      return null;
    }
    const message: Envelope = { v: 1, id: record.id, type: record.type, ts: record.ts };
    if (typeof record.payload === "object" && record.payload !== null && !Array.isArray(record.payload)) {
      message.payload = record.payload as Record<string, unknown>;
    }
    return message;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
