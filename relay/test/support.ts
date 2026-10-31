import { AuthStore } from "../src/auth.js";
import { RelayHub, type BoardConn, type PhoneConn } from "../src/hub.js";
import type { Envelope } from "../src/protocol.js";

export const NOW = 1_700_000_000_000;

export function frame(type: string, id: string, payload?: Record<string, unknown>): Record<string, unknown> {
  const message: Record<string, unknown> = { v: 1, id, type, ts: NOW };
  if (payload) message.payload = payload;
  return message;
}

export class Peer {
  readonly messages: Envelope[] = [];
  closed = false;
  readonly send = (message: Envelope) => {
    this.messages.push(message);
  };
  readonly close = () => {
    this.closed = true;
  };

  ofType(type: string): Envelope[] {
    return this.messages.filter((message) => message.type === type);
  }
}

export function setup(opts?: {
  cmdTimeoutMs?: number;
  tokenTtlMs?: number;
  pairTtlMs?: number;
  pairAttemptLimit?: number;
  idempotencyTtlMs?: number;
}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const logs: string[] = [];
  const auth = new AuthStore({
    adminToken: "admin-token-value",
    boardToken: "board-token-value",
    pairTtlMs: opts?.pairTtlMs ?? 60_000,
    tokenTtlMs: opts?.tokenTtlMs ?? 60_000,
    pairAttemptLimit: opts?.pairAttemptLimit ?? 100,
    pairWindowMs: 60_000,
    now,
  });
  const hub = new RelayHub(auth, {
    cmdTimeoutMs: opts?.cmdTimeoutMs ?? 1_000,
    idempotencyTtlMs: opts?.idempotencyTtlMs ?? 60_000,
    now,
    log: (_level, message) => {
      logs.push(message);
    },
  });
  return { auth, hub, logs, clock, peer: () => new Peer() };
}

export function registerBoard(hub: RelayHub, peer: Peer, boardId = "thinkbook-main", token = "board-token-value"): BoardConn {
  const conn = hub.attachBoard(peer.send, peer.close);
  hub.handleBoard(conn, frame("board.register", `reg-${boardId}-${peer.messages.length}`, {
    boardId,
    token,
    label: "ThinkBook",
  }));
  return conn;
}

export function pairPhone(auth: AuthStore, boardIds = ["thinkbook-main"], name = "pixel") {
  const created = auth.createPairCode(boardIds);
  if (!created.ok) throw new Error(created.message);
  const paired = auth.pair(created.pairCode, name, `ip-${name}`);
  if (!paired.ok) throw new Error(paired.message);
  return { ...paired, pairCode: created.pairCode };
}

export function helloPhone(
  hub: RelayHub,
  auth: AuthStore,
  peer: Peer,
  name = "pixel",
  boardIds = ["thinkbook-main"],
): { conn: PhoneConn; token: string; deviceId: string; boardIds: string[] } {
  const paired = pairPhone(auth, boardIds, name);
  const conn = hub.attachPhone(peer.send, peer.close);
  hub.handlePhone(conn, frame("client.hello", `hello-${name}`, { token: paired.deviceToken, name }));
  return { conn, token: paired.deviceToken, deviceId: paired.deviceId, boardIds: paired.boardIds };
}

export function task(status = "queued", id = "task_01") {
  return { id, title: "Fix login flake", status, updatedAt: NOW, agent: "cursor" };
}

export function cursor(seq: number, eventId: string, generation = 1) {
  return { boardId: "thinkbook-main", generation, seq, eventId };
}
