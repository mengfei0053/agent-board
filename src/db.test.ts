import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_DATABASE_URL,
  databaseUrl,
  databaseKind,
  sqliteFilename,
  getPool,
  closePool,
  repoDataDir,
  redactDatabaseUrl,
} from "./db.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(async () => {
  await closePool();
  for (const key of ["DATABASE_URL", "DATA_DIR", "AGENT_BOARD_REFUSE_REPO_DATA"]) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

describe("U17 databaseUrl / redactDatabaseUrl", () => {
  it("databaseUrl falls back to DEFAULT_DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    delete process.env.DATA_DIR;
    assert.equal(databaseUrl(), DEFAULT_DATABASE_URL);
  });

  it("databaseUrl prefers DATABASE_URL and trims", () => {
    process.env.DATABASE_URL = "  postgresql://u:p@h:5432/db  ";
    assert.equal(databaseUrl(), "postgresql://u:p@h:5432/db");
  });

  it("uses DATA_DIR for unset or whitespace URLs", () => {
    process.env.DATA_DIR = join(tmpdir(), "agent-board-config-test");
    process.env.DATABASE_URL = "   ";
    assert.equal(databaseUrl(), `sqlite:${join(process.env.DATA_DIR, "agent-board.db")}`);
  });

  it("selects supported protocols and rejects invalid configuration", () => {
    assert.equal(databaseKind("postgres://localhost/db"), "postgres");
    assert.equal(databaseKind("postgresql://localhost/db"), "postgres");
    assert.equal(databaseKind("sqlite::memory:"), "sqlite");
    for (const url of ["mysql://localhost/db", "not-a-url"]) {
      assert.throws(() => databaseKind(url), /DATABASE_URL/);
    }
  });

  it("resolves explicit SQLite paths and rejects ambiguous URL syntax", () => {
    assert.equal(sqliteFilename("sqlite:./data/test.db"), resolve("data/test.db"));
    assert.equal(sqliteFilename(`sqlite:${join(tmpdir(), "test.db")}`), join(tmpdir(), "test.db"));
    assert.equal(sqliteFilename("sqlite::memory:"), ":memory:");
    for (const url of ["sqlite:", "sqlite://host/db", "sqlite:file.db?mode=ro", "sqlite:file.db#x", "postgres://host/db"]) {
      assert.throws(() => sqliteFilename(url));
    }
  });

  it("refuses repo database paths before opening the SQLite file", () => {
    process.env.AGENT_BOARD_REFUSE_REPO_DATA = "1";
    process.env.DATABASE_URL = `sqlite:${join(repoDataDir(), "refused-test.db")}`;
    assert.throws(() => getPool(), /refusing to touch repo data/);
  });

  it("redactDatabaseUrl masks password", () => {
    const out = redactDatabaseUrl(
      "postgresql://postgres:s3cret@127.0.0.1:5432/agent_board",
    );
    assert.equal(
      out,
      "postgresql://postgres:***@127.0.0.1:5432/agent_board",
    );
    assert.ok(!out.includes("s3cret"));
  });

  it("redactDatabaseUrl keeps urls without password", () => {
    assert.equal(
      redactDatabaseUrl("postgresql://postgres@127.0.0.1:5432/agent_board"),
      "postgresql://postgres@127.0.0.1:5432/agent_board",
    );
  });

  it("redactDatabaseUrl uses databaseUrl() when arg omitted", () => {
    process.env.DATABASE_URL = "postgresql://a:b@localhost:5432/x";
    assert.equal(redactDatabaseUrl(), "postgresql://a:***@localhost:5432/x");
  });

  it("redactDatabaseUrl returns placeholder on invalid url", () => {
    assert.equal(redactDatabaseUrl("not-a-url"), "(DATABASE_URL)");
  });
});
