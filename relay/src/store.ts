import { randomBytes } from "node:crypto";

export type Device = {
  deviceId: string;
  token: string;
  name: string;
  boardIds: string[];
  expiresAt: number;
  revoked: boolean;
};

export type PairCode = {
  code: string;
  boardIds: string[];
  expiresAt: number;
  attempts: number;
  used: boolean;
};

export type BoardRecord = {
  boardId: string;
  label: string;
  token: string;
};

export type CommandStage = "accepted" | "executed" | "failed" | "timeout" | "unknown";

export type StoredCommand = {
  boardId: string;
  cmd: string;
  idempotencyKey: string;
  stage: CommandStage;
  message?: string;
  task?: Record<string, unknown>;
  /** Metadata only. Prompt and cwd are not copied here. */
  createdAt: number;
};

const PAIR_TTL_MS = 5 * 60 * 1000;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 5;

export class RelayStore {
  readonly boards = new Map<string, BoardRecord>();
  readonly devices = new Map<string, Device>();
  readonly pairCodes = new Map<string, PairCode>();
  readonly commands = new Map<string, StoredCommand>();
  readonly audit: { ts: number; type: string; id: string; boardId?: string }[] = [];
  readonly onlineBoards = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  registerBoard(boardId: string, label: string): BoardRecord {
    const existing = [...this.boards.values()].find((b) => b.boardId === boardId);
    if (existing) return existing;
    const record: BoardRecord = { boardId, label, token: secret() };
    this.boards.set(record.token, record);
    return record;
  }

  boardByToken(token: string): BoardRecord | undefined {
    return this.boards.get(token);
  }

  createPairCode(boardIds: string[]): PairCode {
    const code = `pc_${randomBytes(9).toString("base64url")}`;
    const pair: PairCode = { code, boardIds, expiresAt: this.now() + PAIR_TTL_MS, attempts: 0, used: false };
    this.pairCodes.set(code, pair);
    return pair;
  }

  redeemPairCode(code: string, deviceName: string): { ok: true; device: Device } | { ok: false; error: string; status: number } {
    const pair = this.pairCodes.get(code);
    if (!pair || pair.used || pair.expiresAt <= this.now()) {
      if (pair) pair.attempts += 1;
      return { ok: false, error: "pair code is invalid or expired", status: 401 };
    }
    pair.attempts += 1;
    if (pair.attempts > MAX_PAIR_ATTEMPTS) {
      pair.used = true;
      return { ok: false, error: "pair code is invalid or expired", status: 401 };
    }
    pair.used = true;
    const device = this.issueDevice(deviceName.trim() || "Android phone", pair.boardIds);
    return { ok: true, device };
  }

  refresh(token: string): Device | undefined {
    const current = [...this.devices.values()].find((d) => d.token === token && !d.revoked && d.expiresAt > this.now());
    if (!current) return undefined;
    current.revoked = true;
    return this.issueDevice(current.name, current.boardIds, current.deviceId);
  }

  deviceByToken(token: string): Device | undefined {
    const device = [...this.devices.values()].find((d) => d.token === token);
    if (!device || device.revoked || device.expiresAt <= this.now()) return undefined;
    return device;
  }

  revoke(token: string): void {
    const device = [...this.devices.values()].find((d) => d.token === token);
    if (device) device.revoked = true;
  }

  rememberCommand(cmd: StoredCommand): void {
    this.commands.set(commandKey(cmd.boardId, cmd.idempotencyKey), cmd);
  }

  findCommand(boardId: string, idempotencyKey: string): StoredCommand | undefined {
    return this.commands.get(commandKey(boardId, idempotencyKey));
  }

  note(type: string, id: string, boardId?: string): void {
    this.audit.push({ ts: this.now(), type, id, boardId });
    if (this.audit.length > 500) this.audit.shift();
  }

  private issueDevice(name: string, boardIds: string[], deviceId = `dev_${secret().slice(0, 12)}`): Device {
    const device: Device = {
      deviceId,
      token: secret(),
      name,
      boardIds,
      expiresAt: this.now() + DEVICE_TTL_MS,
      revoked: false,
    };
    this.devices.set(device.token, device);
    return device;
  }
}

function commandKey(boardId: string, idempotencyKey: string): string {
  return `${boardId}\0${idempotencyKey}`;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}
