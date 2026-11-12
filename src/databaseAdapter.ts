import Database from "better-sqlite3";

export type QueryResult<Row> = { rows: Row[]; rowCount: number | null };
export interface DatabaseClient {
  query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  release(): void;
}
export interface DatabasePool {
  query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
}

const JSON_COLUMNS = new Set(["attachments", "worktree", "settings", "thinking_efforts"]);

/** One connection with exclusive leases: standalone queries cannot enter another caller's transaction. */
export class SqlitePool implements DatabasePool {
  private readonly db: Database.Database;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.function("regexp", { deterministic: true }, (pattern, text) => {
      return typeof pattern === "string" && typeof text === "string" && new RegExp(pattern).test(text) ? 1 : 0;
    });
  }

  private async acquire(): Promise<() => void> {
    if (this.closing) throw new Error("SQLite database is closed");
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    return unlock;
  }

  private execute<Row>(sql: string, values: readonly unknown[] = []): QueryResult<Row> {
    const statement = this.db.prepare(sql);
    const bindings = Object.fromEntries(values.map((value, index) => {
      let bound = value ?? null;
      if (bound instanceof Date) bound = bound.toISOString();
      return [String(index + 1), bound];
    }));
    if (!statement.reader) {
      const result = statement.run(bindings);
      return { rows: [], rowCount: Number(result.changes) };
    }
    const rows = statement.all(bindings) as Record<string, unknown>[];
    for (const row of rows) {
      for (const column of JSON_COLUMNS) {
        if (typeof row[column] === "string") {
          try {
            row[column] = JSON.parse(row[column]);
          } catch (cause) {
            throw new Error(`Invalid JSON in database column ${column}`, { cause });
          }
        }
      }
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }

  async query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    const unlock = await this.acquire();
    try {
      return this.execute<Row>(sql, values);
    } finally {
      unlock();
    }
  }

  async connect(): Promise<DatabaseClient> {
    const unlock = await this.acquire();
    let released = false;
    return {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (released) throw new Error("SQLite connection has been released");
        return this.execute<Row>(sql, values);
      },
      release: () => {
        if (released) return;
        released = true;
        try {
          if (this.db.inTransaction) this.db.exec("ROLLBACK");
        } finally {
          unlock();
        }
      },
    };
  }

  async end(): Promise<void> {
    this.closing = true;
    await this.tail;
    this.db.close();
  }
}

/** Bounded batches avoid SQLite's parameter limit and PostgreSQL's protocol limit. Identifiers are code constants. */
export async function insertRows(
  client: Pick<DatabaseClient, "query">,
  table: "task_logs" | "model_history" | "agent_models",
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  suffix = "",
): Promise<void> {
  const allowed = {
    task_logs: ["task_id", "line"],
    model_history: ["kind", "model", "last_used_at"],
    agent_models: ["kind", "model", "thinking_efforts", "updated_at"],
  };
  if (!Object.hasOwn(allowed, table) || columns.some((column) => !allowed[table].includes(column))) {
    throw new Error("Invalid bulk-insert identifiers");
  }
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const placeholders = batch.map((row, rowIndex) => {
      if (row.length !== columns.length) throw new Error(`Invalid row width for ${table}`);
      return `(${row.map((_, index) => `$${rowIndex * columns.length + index + 1}`).join(",")})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders.join(",")} ${suffix}`, batch.flat());
  }
}
