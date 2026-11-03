import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthSnapshot, AuthStorePersistence } from "./auth.js";

/** SQLite keeps the relay's small authorization state synchronous and transactional. */
export class SqliteAuthStore implements AuthStorePersistence {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const filename = resolve(path);
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_auth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  load(): AuthSnapshot | null {
    const row = this.db.prepare("SELECT state_json FROM relay_auth_state WHERE id = 1").get() as { state_json?: unknown } | undefined;
    if (!row) return null;
    if (typeof row.state_json !== "string") throw new Error("relay auth database contains invalid state");
    try {
      return JSON.parse(row.state_json) as AuthSnapshot;
    } catch {
      throw new Error("relay auth database contains invalid JSON");
    }
  }

  save(snapshot: AuthSnapshot): void {
    this.db.prepare(`
      INSERT INTO relay_auth_state (id, version, state_json, updated_at)
      VALUES (1, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(snapshot), Date.now());
  }

  close(): void {
    this.db.close();
  }
}
