import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "./rate-limit.js";

export type PhoneRole = "phone";

export type AuthSnapshot = {
  version: 1;
  bootstrap: { tokenHash: string; revoked: boolean };
  devices: StoredDeviceSession[];
  credentials: PersistedCredential[];
  boardIds: string[];
  revokedBoardIds: string[];
};

export interface AuthStorePersistence {
  load(): AuthSnapshot | null;
  save(snapshot: AuthSnapshot): void;
  close(): void;
}

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

type StoredDeviceSession = DeviceSession & { tokenHash: string };

type PersistedCredential = {
  id: string;
  /** Only SHA-256 hashes are persisted; plaintext credentials never reach the database. */
  tokenHash: string;
  boardIds: string[];
};

type Credential = Omit<PersistedCredential, "boardIds"> & {
  /** null means the bootstrap credential may register any board that is not revoked. */
  boardIds: string[] | null;
  revoked: boolean;
};

const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Long-lived device sessions, board credential hashes, and revocations can be
 * persisted. Pair codes, admin tokens, rate limits, and sockets remain in memory.
 */
export class AuthStore {
  private readonly adminToken: string;
  private readonly pairs = new Map<string, PairRecord>();
  private readonly devices = new Map<string, StoredDeviceSession>();
  private readonly tokensByDevice = new Map<string, Set<string>>();
  private credentials: Credential[] = [];
  private revokedBoardIds = new Set<string>();
  private boardIds = new Set<string>();
  private readonly bootstrap: { token: string; revoked: boolean };
  private readonly persistence?: AuthStorePersistence;
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
      persistence?: AuthStorePersistence;
    },
  ) {
    if (!opts.adminToken) throw new Error("admin token is empty");
    if (!opts.boardToken) throw new Error("board token is empty");
    if (!Number.isFinite(opts.pairTtlMs) || opts.pairTtlMs < 1_000) throw new Error("pair TTL must be at least 1000ms");
    if (!Number.isFinite(opts.tokenTtlMs) || opts.tokenTtlMs <= 0) throw new Error("token TTL must be positive");
    this.adminToken = opts.adminToken;
    this.persistence = opts.persistence;
    this.bootstrap = { token: opts.boardToken, revoked: false };
    this.pairAttempts = new RateLimiter(opts.pairAttemptLimit ?? 8, opts.pairWindowMs ?? 60_000, () => this.now());
    this.restore(this.persistence?.load() ?? null);
  }

  close(): void {
    this.persistence?.close();
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
    this.persist();
    return { ok: true, ...minted };
  }

  refresh(deviceToken: string): PairSuccess | AuthFailure {
    if (!deviceToken) return { ok: false, code: "bad_request", message: "deviceToken is required" };
    const tokenHash = hashSecret(deviceToken);
    const session = this.devices.get(tokenHash);
    if (!session || session.expiresAt <= this.now()) {
      if (session) this.forgetTokenAndPersist(tokenHash, session.deviceId);
      return { ok: false, code: "unauthorized", message: "device token rejected" };
    }
    const minted = this.mint(session.deviceName, session.boardIds, session.deviceId);
    this.forgetToken(tokenHash, session.deviceId, false);
    this.persist();
    return { ok: true, ...minted };
  }

  verifyDevice(token: string): DeviceSession | null {
    const tokenHash = hashSecret(token);
    const session = this.devices.get(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.forgetTokenAndPersist(tokenHash, session.deviceId);
      return null;
    }
    return publicSession(session);
  }

  verifyBoard(token: string, boardId: string): BoardCheck {
    if (!BOARD_ID.test(boardId)) return { ok: false, code: "unauthorized", message: "board token rejected" };
    const tokenHash = hashSecret(token);
    const credential = this.credentials.find((item) => !item.revoked && safeEqual(item.tokenHash, tokenHash));
    if (!credential) return { ok: false, code: "unauthorized", message: "board token rejected" };
    if (this.revokedBoardIds.has(boardId)) return { ok: false, code: "unauthorized", message: "board token rejected" };
    if (credential.boardIds && !credential.boardIds.includes(boardId)) {
      return { ok: false, code: "forbidden", message: "boardId is not allowed for this token" };
    }
    return { ok: true, credentialId: credential.id };
  }

  noteBoard(boardId: string): void {
    if (!BOARD_ID.test(boardId) || this.boardIds.has(boardId)) return;
    this.boardIds.add(boardId);
    this.persist();
  }

  revokeDevice(deviceId: string): boolean {
    const tokens = this.tokensByDevice.get(deviceId);
    if (!tokens || tokens.size === 0) return false;
    for (const token of [...tokens]) this.forgetToken(token, deviceId, false);
    this.persist();
    return true;
  }

  revokeBoardToken(token: string): string | null {
    const tokenHash = hashSecret(token);
    const credential = this.credentials.find((item) => !item.revoked && safeEqual(item.tokenHash, tokenHash));
    if (!credential) return null;
    credential.revoked = true;
    if (credential.boardIds === null) this.bootstrap.revoked = true;
    this.persist();
    return credential.id;
  }

  revokeBoardId(boardId: string): { ok: true; credentialIds: string[] } | { ok: false } {
    if (!BOARD_ID.test(boardId)) return { ok: false };
    this.revokedBoardIds.add(boardId);
    const credentialIds = this.revokeCovering([boardId]);
    this.persist();
    return { ok: true, credentialIds };
  }

  /**
   * `rotate: true` (default) revokes the bootstrap token and any credential covering these ids.
   * `rotate: false` only adds a new scoped credential and leaves existing credentials untouched.
   */
  /**
   * Block one board id and revoke only the credentials scoped to exactly that id.
   * Unlike `revokeBoardId` it leaves the bootstrap credential and other boards untouched.
   */
  unregisterBoard(boardId: string): { ok: true; credentialIds: string[] } | { ok: false } {
    if (!BOARD_ID.test(boardId)) return { ok: false };
    this.revokedBoardIds.add(boardId);
    this.boardIds.add(boardId);
    const credentialIds: string[] = [];
    for (const credential of this.credentials) {
      if (credential.revoked || credential.boardIds === null) continue;
      if (credential.boardIds.length === 1 && credential.boardIds[0] === boardId) {
        credential.revoked = true;
        credentialIds.push(credential.id);
      }
    }
    this.persist();
    return { ok: true, credentialIds };
  }

  /**
   * Forget a board id everywhere: block list, known list, scoped credentials, pending pair codes and
   * device allow-lists. Devices left with no board are revoked. The caller must make sure the board is offline.
   */
  deleteBoard(boardId: string): { ok: true; credentialIds: string[]; revokedDeviceIds: string[] } | { ok: false } {
    if (!BOARD_ID.test(boardId)) return { ok: false };
    this.revokedBoardIds.delete(boardId);
    this.boardIds.delete(boardId);
    const credentialIds: string[] = [];
    for (const credential of this.credentials) {
      if (credential.revoked || credential.boardIds === null || !credential.boardIds.includes(boardId)) continue;
      if (credential.boardIds.length === 1) {
        credential.revoked = true;
        credentialIds.push(credential.id);
      } else {
        credential.boardIds = credential.boardIds.filter((id) => id !== boardId);
      }
    }
    for (const [key, record] of this.pairs) {
      record.boardIds = record.boardIds.filter((id) => id !== boardId);
      if (record.boardIds.length === 0) this.pairs.delete(key);
    }
    const orphaned = new Set<string>();
    for (const session of this.devices.values()) {
      if (!session.boardIds.includes(boardId)) continue;
      session.boardIds = session.boardIds.filter((id) => id !== boardId);
      if (session.boardIds.length === 0) orphaned.add(session.deviceId);
    }
    for (const deviceId of orphaned) {
      for (const token of [...(this.tokensByDevice.get(deviceId) ?? [])]) this.forgetToken(token, deviceId, false);
    }
    this.persist();
    return { ok: true, credentialIds, revokedDeviceIds: [...orphaned] };
  }

  issueBoardToken(
    boardIds: string[],
    options: { rotate?: boolean } = {},
  ): { ok: true; boardToken: string; credentialId: string; boardIds: string[]; revokedCredentialIds: string[] } | AuthFailure {
    const ids = normalizeBoardIds(boardIds);
    if (!ids.ok) return ids;
    const revokedCredentialIds = options.rotate === false ? [] : this.revokeCovering(ids.boardIds);
    for (const boardId of ids.boardIds) this.revokedBoardIds.delete(boardId);
    for (const boardId of ids.boardIds) this.boardIds.add(boardId);
    const boardToken = `bt_${randomBytes(32).toString("base64url")}`;
    const credential: Credential = {
      id: `cred_${randomBytes(8).toString("hex")}`,
      tokenHash: hashSecret(boardToken),
      boardIds: [...ids.boardIds],
      revoked: false,
    };
    this.credentials.push(credential);
    this.persist();
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
      if (credential.boardIds === null) this.bootstrap.revoked = true;
      revoked.push(credential.id);
    }
    return revoked;
  }

  deviceCount(): number {
    const now = this.now();
    for (const [token, session] of this.devices) {
      if (session.expiresAt <= now) this.forgetTokenAndPersist(token, session.deviceId);
    }
    return this.tokensByDevice.size;
  }

  /** Admin metadata only: never return tokens or pair-code hashes. */
  adminState(knownBoardIds: string[] = []): {
    devices: DeviceSession[];
    boards: { boardId: string; revoked: boolean; credentialActive: boolean }[];
    activePairCodes: number;
  } {
    this.deviceCount();
    this.prunePairs();
    const devices = [...new Map([...this.devices.values()].map((session) => [session.deviceId, session])).values()]
      .map(publicSession);
    const boardIds = new Set([...knownBoardIds, ...this.boardIds, ...this.revokedBoardIds]);
    // A revoked credential no longer makes its board "known" (otherwise a deleted board would reappear).
    for (const credential of this.credentials) {
      if (credential.revoked) continue;
      for (const boardId of credential.boardIds ?? []) boardIds.add(boardId);
    }
    for (const session of devices) for (const boardId of session.boardIds) boardIds.add(boardId);
    for (const pair of this.pairs.values()) for (const boardId of pair.boardIds) boardIds.add(boardId);
    const boards = [...boardIds].sort(compareText).map((boardId) => ({
      boardId,
      revoked: this.revokedBoardIds.has(boardId),
      credentialActive: !this.revokedBoardIds.has(boardId) && this.credentials.some((credential) =>
        !credential.revoked && (credential.boardIds === null || credential.boardIds.includes(boardId))),
    }));
    return { devices, boards, activePairCodes: this.pairs.size };
  }

  private restore(snapshot: AuthSnapshot | null): void {
    if (!snapshot) {
      this.credentials = [this.bootstrapCredential()];
      this.persist();
      return;
    }
    validateSnapshot(snapshot);
    this.bootstrap.revoked = snapshot.bootstrap.revoked && snapshot.bootstrap.tokenHash === hashSecret(this.bootstrap.token);
    this.credentials = [
      this.bootstrapCredential(),
      ...snapshot.credentials.map((credential) => ({
        id: credential.id,
        tokenHash: credential.tokenHash,
        boardIds: [...credential.boardIds],
        revoked: false,
      })),
    ];
    this.revokedBoardIds = new Set(snapshot.revokedBoardIds);
    this.boardIds = new Set(snapshot.boardIds);
    for (const session of snapshot.devices) {
      if (session.expiresAt <= this.now()) continue;
      this.devices.set(session.tokenHash, { ...session, boardIds: [...session.boardIds] });
      this.tokensByDevice.set(session.deviceId, new Set([session.tokenHash]));
    }
    this.persist();
  }

  private bootstrapCredential(): Credential {
    return {
      id: "cred_bootstrap",
      tokenHash: hashSecret(this.bootstrap.token),
      boardIds: null,
      revoked: this.bootstrap.revoked,
    };
  }

  private persist(): void {
    if (!this.persistence) return;
    const devices = [...new Map([...this.devices.values()].map((session) => [session.deviceId, session])).values()]
      .map((session) => ({ ...session, boardIds: [...session.boardIds] }));
    const credentials = this.credentials.flatMap((credential) =>
      credential.boardIds !== null && !credential.revoked
        ? [{ id: credential.id, tokenHash: credential.tokenHash, boardIds: [...credential.boardIds] }]
        : []);
    this.persistence.save({
      version: 1,
      bootstrap: { tokenHash: hashSecret(this.bootstrap.token), revoked: this.bootstrap.revoked },
      devices,
      credentials,
      boardIds: [...this.boardIds].sort(compareText),
      revokedBoardIds: [...this.revokedBoardIds].sort(compareText),
    });
  }

  private mint(deviceName: string, boardIds: string[], deviceId = `dev_${randomBytes(8).toString("hex")}`): Omit<PairSuccess, "ok"> {
    const deviceToken = `dt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + this.opts.tokenTtlMs;
    const session: StoredDeviceSession = {
      deviceId,
      deviceName,
      role: "phone",
      boardIds: [...boardIds],
      expiresAt,
      tokenHash: hashSecret(deviceToken),
    };
    this.devices.set(session.tokenHash, session);
    const bucket = this.tokensByDevice.get(deviceId) ?? new Set<string>();
    bucket.add(session.tokenHash);
    this.tokensByDevice.set(deviceId, bucket);
    return { deviceId, deviceToken, role: "phone", boardIds: [...boardIds], expiresAt };
  }

  private forgetTokenAndPersist(token: string, deviceId: string): void {
    this.forgetToken(token, deviceId, true);
  }

  private forgetToken(token: string, deviceId: string, persist = false): void {
    this.devices.delete(token);
    const bucket = this.tokensByDevice.get(deviceId);
    if (!bucket) return;
    bucket.delete(token);
    if (bucket.size === 0) this.tokensByDevice.delete(deviceId);
    if (persist) this.persist();
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

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicSession(session: StoredDeviceSession): DeviceSession {
  return {
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    role: "phone",
    boardIds: [...session.boardIds],
    expiresAt: session.expiresAt,
  };
}

function validateSnapshot(snapshot: AuthSnapshot): void {
  const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const validIds = (value: unknown) => Array.isArray(value) && value.length >= 1 && value.length <= 20 &&
    value.every((id) => typeof id === "string" && BOARD_ID.test(id));
  const valid = snapshot?.version === 1 &&
    typeof snapshot.bootstrap?.revoked === "boolean" && validHash(snapshot.bootstrap.tokenHash) &&
    Array.isArray(snapshot.devices) && snapshot.devices.every((session) =>
      session && typeof session.deviceId === "string" && typeof session.deviceName === "string" &&
      session.role === "phone" && validHash(session.tokenHash) && validIds(session.boardIds) &&
      Number.isSafeInteger(session.expiresAt) && session.expiresAt > 0) &&
    Array.isArray(snapshot.credentials) && snapshot.credentials.every((credential) =>
      credential && typeof credential.id === "string" && validHash(credential.tokenHash) && validIds(credential.boardIds)) &&
    Array.isArray(snapshot.boardIds) && snapshot.boardIds.every((id) => typeof id === "string" && BOARD_ID.test(id)) &&
    Array.isArray(snapshot.revokedBoardIds) && snapshot.revokedBoardIds.every((id) => typeof id === "string" && BOARD_ID.test(id));
  if (!valid) throw new Error("relay auth database contains invalid state");
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
