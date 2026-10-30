import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_DATABASE_URL,
  databaseUrl,
  redactDatabaseUrl,
} from "./db.js";

const ORIG = process.env.DATABASE_URL;

afterEach(() => {
  if (ORIG === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIG;
});

describe("U17 databaseUrl / redactDatabaseUrl", () => {
  it("databaseUrl falls back to DEFAULT_DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    assert.equal(databaseUrl(), DEFAULT_DATABASE_URL);
  });

  it("databaseUrl prefers DATABASE_URL and trims", () => {
    process.env.DATABASE_URL = "  postgresql://u:p@h:5432/db  ";
    assert.equal(databaseUrl(), "postgresql://u:p@h:5432/db");
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
