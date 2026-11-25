import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const events = {
  info: new Set(["app_started", "relay_connected", "snapshot_synced", "command_sent", "command_executed"]),
  error: new Set(["relay_disconnected", "auth_rejected", "sync_gap", "command_failed", "command_timeout"]),
};
type Level = keyof typeof events;
export type Entry = { id: string; ts: number; level: Level; event: string };
type StoredEntry = Entry & { deviceId: string; receivedAt: number };
export type Query = { deviceId?: string; level?: Level; before?: number; limit: number };
const WEEK = 7 * 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLogBatch(body: unknown): Entry[] | null {
  if (!record(body) || Object.keys(body).length !== 1 || !Array.isArray(body.entries) ||
      body.entries.length < 1 || body.entries.length > 50) return null;
  const batch: Entry[] = [];
  for (const item of body.entries) {
    if (!record(item) || Object.keys(item).length !== 4) return null;
    const { id, ts, level, event } = item;
    if (typeof id !== "string" || !uuid.test(id) || typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0 ||
        (level !== "info" && level !== "error") || typeof event !== "string" || !events[level].has(event)) return null;
    batch.push({ id, ts, level, event });
  }
  return batch;
}

// before is the exclusive positive decimal receipt sequence, not a client timestamp.
export function parseLogQuery(params: URLSearchParams): Query | null {
  const query: Query = { limit: 50 };
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === "deviceId" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) query.deviceId = value;
    else if (key === "level" && (value === "info" || value === "error")) query.level = value;
    else if ((key === "before" || key === "limit") && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) {
      if (key === "limit" && Number(value) > 100) return null;
      query[key] = Number(value);
    } else return null;
  }
  return query;
}

export class DeviceLogs {
  private readonly db: DatabaseSync;
  // Fixed minute window: at most 30 new batches/device and 120 total (50 entries/batch).
  private windowStart = -Infinity;
  private writes = 0;
  private readonly deviceWrites = new Map<string, number>();

  constructor(filename: string | undefined, private readonly now: () => number) {
    this.db = new DatabaseSync(filename ?? ":memory:");
    try {
      if (filename) chmodSync(filename, 0o600);
      this.db.exec(`
        PRAGMA busy_timeout = 2000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS device_logs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          deviceId TEXT NOT NULL, id TEXT NOT NULL COLLATE NOCASE, ts INTEGER NOT NULL,
          level TEXT NOT NULL, event TEXT NOT NULL, receivedAt INTEGER NOT NULL,
          UNIQUE(deviceId, id)
        );
        CREATE INDEX IF NOT EXISTS device_logs_device_seq ON device_logs(deviceId, seq);
        CREATE INDEX IF NOT EXISTS device_logs_age ON device_logs(receivedAt);
      `);
      this.pruneExpired();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  pruneExpired(): void {
    this.db.prepare("DELETE FROM device_logs WHERE receivedAt <= ?").run(this.now() - WEEK);
  }

  append(deviceId: string, entries: Entry[]): string[] | "rate_limited" | "id_conflict" {
    const now = this.now();
    const cutoff = now - WEEK;
    const find = this.db.prepare("SELECT ts, level, event FROM device_logs WHERE deviceId = ? AND id = ? AND receivedAt > ?");
    const pending = new Map<string, Entry>();
    const acked = new Map<string, string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        const key = entry.id.toLowerCase();
        if (!acked.has(key)) acked.set(key, entry.id);
        const existing = pending.get(key) ?? find.get(deviceId, entry.id, cutoff);
        if (!existing) pending.set(key, entry);
        else if (existing.ts !== entry.ts || existing.level !== entry.level || existing.event !== entry.event) {
          this.db.exec("ROLLBACK");
          return "id_conflict";
        }
      }
      if (pending.size) {
        if (now - this.windowStart >= 60_000) {
          this.windowStart = now;
          this.writes = 0;
          this.deviceWrites.clear();
        }
        const count = this.deviceWrites.get(deviceId) ?? 0;
        if (count >= 30 || this.writes >= 120) {
          this.db.exec("ROLLBACK");
          return "rate_limited";
        }
        this.db.prepare("DELETE FROM device_logs WHERE receivedAt <= ?").run(cutoff);
        const insert = this.db.prepare("INSERT INTO device_logs(deviceId,id,ts,level,event,receivedAt) VALUES (?,?,?,?,?,?)");
        for (const entry of pending.values()) insert.run(deviceId, entry.id, entry.ts, entry.level, entry.event, now);
        this.db.prepare(`DELETE FROM device_logs WHERE deviceId = ? AND seq <= (
          SELECT seq FROM device_logs WHERE deviceId = ? ORDER BY seq DESC LIMIT 1 OFFSET 1000
        )`).run(deviceId, deviceId);
        this.db.exec(`DELETE FROM device_logs WHERE seq <= (
          SELECT seq FROM device_logs ORDER BY seq DESC LIMIT 1 OFFSET 10000
        )`);
      }
      this.db.exec("COMMIT");
      if (pending.size) {
        this.writes++;
        this.deviceWrites.set(deviceId, (this.deviceWrites.get(deviceId) ?? 0) + 1);
      }
      return [...acked.values()];
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list({ deviceId, level, before, limit }: Query): { entries: StoredEntry[]; nextCursor: string | null } {
    const where = ["receivedAt > ?"];
    const args: (string | number)[] = [this.now() - WEEK];
    if (deviceId !== undefined) { where.push("deviceId = ?"); args.push(deviceId); }
    if (level !== undefined) { where.push("level = ?"); args.push(level); }
    if (before !== undefined) { where.push("seq < ?"); args.push(before); }
    const rows = this.db.prepare(`SELECT seq,id,deviceId,ts,level,event,receivedAt FROM device_logs
      WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...args, limit + 1) as (StoredEntry & { seq: number })[];
    const page = rows.slice(0, limit);
    return {
      entries: page.map(({ seq: _seq, ...entry }) => entry),
      nextCursor: rows.length > limit ? String(page[page.length - 1]!.seq) : null,
    };
  }
}
