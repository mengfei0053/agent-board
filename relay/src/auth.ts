import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "./rate-limit.js";

export type PhoneRole = "phone";

export type DeviceSession = {
  deviceId: string;
  deviceName: string;
  role: PhoneRole;
  boardIds: string[];
  expiresAt: number;
};

export type PairSuccess = {
  ok: true;
  deviceId: string;
  deviceToken: string;
  role: PhoneRole;
  boardIds: string[];
  expiresAt: number;
};

export type AuthFailure = {
  ok: false;
  code: "unauthorized" | "bad_request" | "rate_limited" | "not_found";
  message: string;
};

export type BoardCheck =
  | { ok: true; credentialId: string }
  | { ok: false; code: "unauthorized" | "forbidden"; message: string };

type PairRecord = {
  boardIds: string[];
  expiresAt: number;
};

type Credential = {
  id: string;
  token: string;
  /** null means the bootstrap credential may register any board that is not revoked. */
  boardIds: string[] | null;
  revoked: boolean;
};

const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Admin token, pair codes, device tokens, and board credentials live here only.
 * Pair codes are deleted when used. Nothing is written to disk.
 */
export class AuthStore {
  private readonly adminToken: string;
  private readonly pairs = new Map<string, PairRecord>();
  private readonly devices = new Map<string, DeviceSession>();
  private readonly tokensByDevice = new Map<string, Set<string>>();
  private readonly revokedDevices = new Set<string>();
  private readonly credentials: Credential[] = [];
  private readonly revokedBoardIds = new Set<string>();
  private readonly pairAttempts: RateLimiter;

  constructor(
    private readonly opts: {
      adminToken: string;
      boardToken: string;
      pairTtlMs: number;
      tokenTtlMs: number;
      pairAttemptLimit?: number;
      pairWindowMs?: number;
      now?: () => number;
    },
  ) {
    if (!opts.adminToken) throw new Error("admin token is empty");
    if (!opts.boardToken) throw new Error("board token is empty");
    if (!Number.isFinite(opts.pairTtlMs) || opts.pairTtlMs < 1_000) throw new Error("pair TTL must be at least 1000ms");
    if (!Number.isFinite(opts.tokenTtlMs) || opts.tokenTtlMs <= 0) throw new Error("token TTL must be positive");
    this.adminToken = opts.adminToken;
    this.pairAttempts = new RateLimiter(opts.pairAttemptLimit ?? 8, opts.pairWindowMs ?? 60_000, () => this.now());
    this.credentials.push({
      id: `cred_${randomBytes(8).toString("hex")}`,
      token: opts.boardToken,
      boardIds: null,
      revoked: false,
    });
  }

  verifyAdmin(token: string): boolean {
    if (!token) return false;
    return safeEqual(token, this.adminToken);
  }

  createPairCode(boardIds: string[], ttlMs?: number): { ok: true; pairCode: string; boardIds: string[]; expiresAt: number } | AuthFailure {
    const ids = normalizeBoardIds(boardIds);
    if (!ids.ok) return ids;
    const ttl = ttlMs ?? this.opts.pairTtlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > this.opts.pairTtlMs) {
      return { ok: false, code: "bad_request", message: `ttlMs must be an integer from 1000 to ${this.opts.pairTtlMs}` };
    }
    this.prunePairs();
    const pairCode = `pc_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + ttl;
    this.pairs.set(hashCode(pairCode), { boardIds: ids.boardIds, expiresAt });
    return { ok: true, pairCode, boardIds: [...ids.boardIds], expiresAt };
  }

  pair(pairCode: string, deviceName: string | undefined, ip: string): PairSuccess | AuthFailure {
    if (!this.pairAttempts.allow(ip || "unknown")) {
      return { ok: false, code: "rate_limited", message: "too many pair attempts" };
    }
    const code = pairCode.trim();
    if (!code) return { ok: false, code: "bad_request", message: "pairCode is required" };
    const name = (deviceName ?? "phone").trim();
    if (!name || name.length > 80) {
      return { ok: false, code: "bad_request", message: "deviceName must be 1-80 characters" };
    }
    const key = hashCode(code);
    const record = this.pairs.get(key);
    if (!record || record.expiresAt <= this.now()) {
      if (record) this.pairs.delete(key);
      return { ok: false, code: "unauthorized", message: "pair code rejected" };
    }
    this.pairs.delete(key);
    const minted = this.mint(name, record.boardIds);
    return { ok: true, ...minted };
  }

  refresh(deviceToken: string): PairSuccess | AuthFailure {
    if (!deviceToken) return { ok: false, code: "bad_request", message: "deviceToken is required" };
    const session = this.devices.get(deviceToken);
    if (!session || session.expiresAt <= this.now() || this.revokedDevices.has(session.deviceId)) {
      if (session) this.forgetToken(deviceToken, session.deviceId);
      return { ok: false, code: "unauthorized", message: "device token rejected" };
    }
    const minted = this.mint(session.deviceName, session.boardIds, session.deviceId);
    this.forgetToken(deviceToken, session.deviceId);
    return { ok: true, ...minted };
  }

  verifyDevice(token: string): DeviceSession | null {
    const session = this.devices.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now() || this.revokedDevices.has(session.deviceId)) {
      this.forgetToken(token, session.deviceId);
      return null;
    }
    return { ...session, boardIds: [...session.boardIds] };
  }

  verifyBoard(token: string, boardId: string): BoardCheck {
    if (!BOARD_ID.test(boardId)) return { ok: false, code: "unauthorized", message: "board token rejected" };
    const credential = this.credentials.find((item) => !item.revoked && safeEqual(item.token, token));
    if (!credential) return { ok: false, code: "unauthorized", message: "board token rejected" };
    if (this.revokedBoardIds.has(boardId)) return { ok: false, code: "unauthorized", message: "board token rejected" };
    if (credential.boardIds && !credential.boardIds.includes(boardId)) {
      return { ok: false, code: "forbidden", message: "boardId is not allowed for this token" };
    }
    return { ok: true, credentialId: credential.id };
  }

  revokeDevice(deviceId: string): boolean {
    const tokens = this.tokensByDevice.get(deviceId);
    if (!tokens || tokens.size === 0) return false;
    for (const token of [...tokens]) this.forgetToken(token, deviceId);
    this.revokedDevices.add(deviceId);
    return true;
  }

  revokeBoardToken(token: string): string | null {
    const credential = this.credentials.find((item) => !item.revoked && safeEqual(item.token, token));
    if (!credential) return null;
    credential.revoked = true;
    return credential.id;
  }

  revokeBoardId(boardId: string): { ok: true; credentialIds: string[] } | { ok: false } {
    if (!BOARD_ID.test(boardId)) return { ok: false };
    this.revokedBoardIds.add(boardId);
    return { ok: true, credentialIds: this.revokeCovering([boardId]) };
  }

  issueBoardToken(
    boardIds: string[],
  ): { ok: true; boardToken: string; credentialId: string; boardIds: string[]; revokedCredentialIds: string[] } | AuthFailure {
    const ids = normalizeBoardIds(boardIds);
    if (!ids.ok) return ids;
    const revokedCredentialIds = this.revokeCovering(ids.boardIds);
    for (const boardId of ids.boardIds) this.revokedBoardIds.delete(boardId);
    const boardToken = `bt_${randomBytes(32).toString("base64url")}`;
    const credential: Credential = {
      id: `cred_${randomBytes(8).toString("hex")}`,
      token: boardToken,
      boardIds: [...ids.boardIds],
      revoked: false,
    };
    this.credentials.push(credential);
    return { ok: true, boardToken, credentialId: credential.id, boardIds: [...ids.boardIds], revokedCredentialIds };
  }

  /** Revoke bootstrap (null scope) and any credential that lists one of these boards. */
  private revokeCovering(boardIds: string[]): string[] {
    const revoked: string[] = [];
    for (const credential of this.credentials) {
      if (credential.revoked) continue;
      const covers = credential.boardIds === null || boardIds.some((id) => credential.boardIds?.includes(id));
      if (!covers) continue;
      credential.revoked = true;
      revoked.push(credential.id);
    }
    return revoked;
  }

  deviceCount(): number {
    const now = this.now();
    for (const [token, session] of this.devices) {
      if (session.expiresAt <= now || this.revokedDevices.has(session.deviceId)) this.forgetToken(token, session.deviceId);
    }
    return this.tokensByDevice.size;
  }

  private mint(deviceName: string, boardIds: string[], deviceId = `dev_${randomBytes(8).toString("hex")}`): Omit<PairSuccess, "ok"> {
    const deviceToken = `dt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + this.opts.tokenTtlMs;
    const session: DeviceSession = { deviceId, deviceName, role: "phone", boardIds: [...boardIds], expiresAt };
    this.devices.set(deviceToken, session);
    const bucket = this.tokensByDevice.get(deviceId) ?? new Set<string>();
    bucket.add(deviceToken);
    this.tokensByDevice.set(deviceId, bucket);
    return { deviceId, deviceToken, role: "phone", boardIds: [...boardIds], expiresAt };
  }

  private forgetToken(token: string, deviceId: string): void {
    this.devices.delete(token);
    const bucket = this.tokensByDevice.get(deviceId);
    if (!bucket) return;
    bucket.delete(token);
    if (bucket.size === 0) this.tokensByDevice.delete(deviceId);
  }

  private prunePairs(): void {
    const now = this.now();
    for (const [key, record] of this.pairs) {
      if (record.expiresAt <= now) this.pairs.delete(key);
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

export function generateAdminToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateBoardToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeBoardIds(boardIds: string[]): { ok: true; boardIds: string[] } | AuthFailure {
  if (!Array.isArray(boardIds) || boardIds.length < 1 || boardIds.length > 20) {
    return { ok: false, code: "bad_request", message: "boardIds must contain 1-20 ids" };
  }
  const unique: string[] = [];
  for (const boardId of boardIds) {
    if (typeof boardId !== "string" || !BOARD_ID.test(boardId)) {
      return { ok: false, code: "bad_request", message: "boardIds contains an invalid id" };
    }
    if (!unique.includes(boardId)) unique.push(boardId);
  }
  return { ok: true, boardIds: unique };
}

function hashCode(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
