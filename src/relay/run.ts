import { WebSocket } from "ws";
import type { EnabledRelayConfig } from "./config.js";
import { loadRelayDialerConfig } from "./config.js";
import { createBoardFacade, type BoardFacade } from "./facade.js";
import { ConnectorSession } from "./session.js";
import { CreateIdempotency } from "./idempotency.js";
import {
  encodeFrame,
  frame,
  newMessageId,
  parseEnvelope,
  redactWsUrl,
  type Envelope,
} from "./envelope.js";
import { RELAY_LIMITS } from "./limits.js";

export type RelayLog = (level: "info" | "warn" | "error", message: string) => void;

export type EmbeddedRelay = {
  /**
   * Resolves after the first generation finishes bootstrap (snapshot sent).
   * Rejects if that first attempt fails. The reconnect loop keeps running either way.
   * Production must not let this rejection escape `main`.
   */
  ready: Promise<void>;
  close(): Promise<void>;
};

type Phase = "register" | "bootstrap" | "live";
type OnceResult = { ok: boolean; registered: boolean };

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeClose(ws: WebSocket | null): void {
  if (!ws) return;
  try {
    ws.terminate();
  } catch {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

function rawText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function sendFrame(ws: WebSocket, type: string, payload: Record<string, unknown>, id?: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > RELAY_LIMITS.maxOutboundBufferedBytes) {
    safeClose(ws);
    return false;
  }
  const raw = encodeFrame(frame(type, payload, id));
  if (Buffer.byteLength(raw) > RELAY_LIMITS.maxFrameBytes) {
    safeClose(ws);
    return false;
  }
  try {
    ws.send(raw);
    return true;
  } catch {
    safeClose(ws);
    return false;
  }
}

function openSocket(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  onSocket: (ws: WebSocket) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    onSocket(ws);
    let settled = false;
    let opened = false;
    let closing = false;
    const timer = setTimeout(() => fail(new Error("open timeout")), timeoutMs);
    const onAbort = () => fail(new Error("aborted"));
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      ws.off("open", onOpen);
    }
    function fail(err: Error) {
      if (settled) return;
      settled = true;
      closing = true;
      cleanup();
      safeClose(ws);
      reject(err);
    }
    function onOpen() {
      if (settled) return;
      settled = true;
      opened = true;
      cleanup();
      resolve(ws);
    }
    function onError() {
      if (!settled) {
        fail(new Error("socket error"));
        return;
      }
      if (opened && !closing) {
        closing = true;
        safeClose(ws);
      }
    }
    signal.addEventListener("abort", onAbort);
    ws.on("error", onError);
    ws.on("open", onOpen);
  });
}

async function runOnce(opts: {
  config: EnabledRelayConfig;
  facade: BoardFacade;
  idempotency: CreateIdempotency;
  signal: AbortSignal;
  log: RelayLog;
  onSocket: (ws: WebSocket | null) => void;
  onSession: (session: ConnectorSession | null) => void;
  onBootstrapped: () => void;
}): Promise<OnceResult> {
  if (opts.signal.aborted) return { ok: false, registered: false };
  let ws: WebSocket | null = null;
  let session: ConnectorSession | null = null;
  try {
    ws = await openSocket(opts.config.relayWsUrl, opts.signal, opts.config.openTimeoutMs, opts.onSocket);
    opts.onSocket(ws);
    const registerId = newMessageId("r");
    const inbox: Envelope[] = [];
    let phase: Phase = "register";
    let resolveAck: ((msg: Envelope) => void) | null = null;

    ws.on("message", (data) => {
      try {
        const text = rawText(data);
        if (Buffer.byteLength(text) > RELAY_LIMITS.maxFrameBytes) {
          safeClose(ws);
          return;
        }
        const msg = parseEnvelope(text);
        if (!msg) {
          safeClose(ws);
          return;
        }
        if (resolveAck && msg.id === registerId && (msg.type === "ack" || msg.type === "err")) {
          const done = resolveAck;
          resolveAck = null;
          done(msg);
          return;
        }
        if (phase !== "live") {
          if (inbox.length >= RELAY_LIMITS.maxPendingFrames) {
            safeClose(ws);
            return;
          }
          inbox.push(msg);
          return;
        }
        session?.handleCommand(msg);
      } catch {
        safeClose(ws);
      }
    });

    const closed = new Promise<void>((resolve) => {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
    });

    const generation = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("register timeout")), opts.config.registerTimeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      const fail = (err: Error) => {
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        resolveAck = null;
        reject(err);
      };
      void closed.then(() => fail(new Error("socket closed")));
      resolveAck = (msg) => {
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        if (msg.type === "err") {
          opts.log("warn", "relay register rejected");
          reject(new Error("register rejected"));
          return;
        }
        if (!validGeneration(msg.payload.generation)) {
          opts.log("warn", "relay register ack missing generation");
          reject(new Error("register ack missing generation"));
          return;
        }
        resolve(msg.payload.generation);
      };
      if (!sendFrame(ws!, "board.register", {
        boardId: opts.config.boardId,
        token: opts.config.boardToken,
        label: opts.config.boardLabel,
      }, registerId)) {
        fail(new Error("register send failed"));
      }
    });

    phase = "bootstrap";
    session = new ConnectorSession({
      generation,
      boardId: opts.config.boardId,
      facade: opts.facade,
      idempotency: opts.idempotency,
      log: opts.log,
      onOverflow: () => safeClose(ws),
      onFatal: () => safeClose(ws),
      send: (type, payload, id) => {
        if (ws) sendFrame(ws, type, payload, id);
      },
    });
    opts.onSession(session);

    const bootstrapDone = session.bootstrap().then(
      () => "ok" as const,
      (err: unknown) => err,
    );
    const winner = await Promise.race([
      bootstrapDone,
      closed.then(() => "closed" as const),
    ]);
    if (winner === "closed") throw new Error("socket closed");
    if (winner !== "ok") throw winner instanceof Error ? winner : new Error("bootstrap failed");

    phase = "live";
    while (inbox.length) {
      const pending = inbox.splice(0);
      for (const msg of pending) session.handleCommand(msg);
    }
    opts.onBootstrapped();

    await Promise.race([
      closed,
      new Promise<void>((_resolve, reject) => {
        if (opts.signal.aborted) reject(new Error("aborted"));
        else opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    return { ok: true, registered: true };
  } catch (err) {
    if (opts.signal.aborted) return { ok: false, registered: false };
    const registered = session != null;
    if (!registered) {
      const reason = err instanceof Error ? err.message : "relay session failed";
      if (
        reason !== "register rejected"
        && reason !== "register ack missing generation"
        && reason !== "aborted"
      ) {
        opts.log("warn", `relay session ended before ready (${reason})`);
      }
    }
    return { ok: false, registered };
  } finally {
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    opts.onSession(null);
    safeClose(ws);
    opts.onSocket(null);
  }
}

export function startEmbeddedRelay(opts: {
  config: EnabledRelayConfig;
  facade: BoardFacade;
  log?: RelayLog;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): EmbeddedRelay {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? abortableSleep;
  const abort = new AbortController();
  const idempotency = new CreateIdempotency();
  let currentWs: WebSocket | null = null;
  let currentSession: ConnectorSession | null = null;
  let readySettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (err: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Keep the production rejection handled even when nobody awaits `ready`.
  void ready.catch(() => {});

  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const markFailed = () => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error("relay dialer not ready"));
  };

  let loopDone!: Promise<void>;
  const handle: EmbeddedRelay = {
    ready,
    async close() {
      abort.abort();
      try {
        currentSession?.close();
      } catch {
        /* ignore */
      }
      safeClose(currentWs);
      await loopDone;
    },
  };

  loopDone = (async () => {
    let delay = opts.config.reconnectMinMs;
    while (!abort.signal.aborted) {
      let result: OnceResult = { ok: false, registered: false };
      try {
        result = await runOnce({
          config: opts.config,
          facade: opts.facade,
          idempotency,
          signal: abort.signal,
          log,
          onSocket: (ws) => {
            currentWs = ws;
          },
          onSession: (session) => {
            currentSession = session;
          },
          onBootstrapped: markReady,
        });
      } catch {
        if (!abort.signal.aborted) log("error", "relay dialer loop error");
        result = { ok: false, registered: false };
      }
      if (abort.signal.aborted) break;
      if (!result.ok) markFailed();
      if (abort.signal.aborted) break;
      const wait = result.registered ? opts.config.reconnectMinMs : delay;
      if (result.registered) delay = opts.config.reconnectMinMs;
      else delay = Math.min(delay * 2, opts.config.reconnectMaxMs);
      log("info", `relay reconnect in ${wait}ms`);
      await sleep(wait, abort.signal);
    }
    if (!readySettled) markFailed();
  })();

  log("info", `relay dialer connecting ${redactWsUrl(opts.config.relayWsUrl)} as ${opts.config.boardId}`);
  return handle;
}

export function maybeStartEmbeddedRelay(opts?: {
  env?: NodeJS.ProcessEnv;
  log?: RelayLog;
  facade?: BoardFacade;
}): EmbeddedRelay | null {
  const config = loadRelayDialerConfig(opts?.env ?? process.env);
  const log = opts?.log ?? defaultLog;
  if (!config.enabled) {
    log(config.level, config.reason);
    return null;
  }
  log("info", `relay dialer enabled for ${config.boardId} via ${redactWsUrl(config.relayWsUrl)}`);
  return startEmbeddedRelay({
    config,
    facade: opts?.facade ?? createBoardFacade(),
    log,
  });
}

function defaultLog(level: "info" | "warn" | "error", message: string): void {
  const line = `[relay] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
