# PostgreSQL / SQLite implementation and verification plan

## Scope and compatibility

- Select one backend through `DATABASE_URL`; no dual writes or automatic cross-database migration.
- Keep `postgres:` / `postgresql:` deployments and the existing Compose stack unchanged.
- Default to a file-backed SQLite database at `DATA_DIR/agent-board.db` when no URL is configured. Existing PostgreSQL users must keep their explicit URL; never fall back after a connection failure.
- Support `sqlite:./relative.db`, `sqlite:/absolute/path.db`, and `sqlite::memory:`. Relative explicit paths resolve against the process working directory.
- Preserve HTTP/API and frontend behavior, legacy db.json import, filesystem safety checks, and asynchronous persistence/flush semantics.
- Standalone Relay storage and cross-database export/import are out of scope.

## Implementation

1. Introduce a small query/result/connection interface behind the existing `getPool` entry point. PostgreSQL retains pg; SQLite uses better-sqlite3 to retain Node 20+ compatibility.
2. Enable SQLite foreign keys, WAL for file databases and busy timeout. Serialize connection leases and standalone queries so independent asynchronous transactions cannot interleave on one SQLite connection. Release must not leak an open transaction.
3. Keep schema types/defaults and incremental upgrades backend-specific. SQLite uses TEXT for ISO UTC timestamps and JSON, INTEGER PRIMARY KEY for log IDs, and PRAGMA table_info to add missing columns. Initialization must be repeatable.
4. Make application SQL portable where simple; isolate array membership and regex predicates in explicit dialect helpers. Replace PostgreSQL recordset/UNNEST operations with bounded parameterized batches and explicit transactions. Do not implement a general-purpose SQL translator.
5. Decode known JSON columns consistently with pg, preserve nulls, return affected row counts, and bind all user data as parameters.
6. Parameterize integration test database setup. Run the same API suite against isolated embedded PostgreSQL and isolated SQLite. Remove PostgreSQL-only test fixtures rather than weakening assertions.
7. Document local defaults, explicit URLs, backend switching, backup/concurrency constraints, and PostgreSQL deployment continuity.

## Acceptance tests

- Configuration: default DATA_DIR location; explicit relative/absolute/memory SQLite URLs; PostgreSQL URLs; invalid protocols; redacted passwords; repo-data safety.
- Adapter contract: repeated and out-of-order parameters, SQL-injection strings, nulls, JSON, Unicode, timestamps, affected-row counts, transactions, rollback and concurrent lease ordering; close/reopen persistence.
- Schema: first initialization, repeated initialization and additive upgrades; foreign-key enforcement/cascade; model history backfill preserves latest usage.
- API matrix (both backends): existing workspace/task CRUD, continuation, output/prompt/side-job records, settings, model history, model sync stale removal and rollback, log pruning, attachment records and isolation.
- Regression: all unit tests and current browser E2E; active diagnostics on modified code; typecheck (record the pre-existing web/markdown.js declaration failure separately if still present).
- Test isolation: temporary database/file/upload/log directories only, no production database or repo data tree access.

## Execution record

Implemented the adapter, dialect-aware queries, additive schema upgrades, test matrix and user documentation. The static PostgreSQL DDL is materialized into SQLite DDL for JSON/timestamp/default/autoincrement types; runtime application queries are not passed through a generic SQL rewriter.

Verified locally:

- `pnpm test:unit`: 408 passed (configuration, adapter leases/rollback/batches/reopen, and SQLite metadata regex coverage included).
- `pnpm test:integration`: PostgreSQL 43 passed and SQLite 43 passed. Includes schema upgrades/repeated initialization, UTC/model-history backfill, persisted JSON/children/uploads after close/reopen, FK rollback/cascade, legacy JSON import, and existing API contracts.
- `pnpm test:e2e`: all six existing browser scripts passed. These use mock APIs; real database behavior is covered by the integration matrix, not claimed as browser-to-database coverage.
- Real default-config HTTP smoke: no DATABASE_URL; isolated DATA_DIR SQLite created; `/api/health` healthy; SIGTERM exits with code 0. A second two-process HTTP smoke creates a workspace/draft, stops the service, restarts it and verifies both records survive.
- Explicit unavailable PostgreSQL smoke: initialization rejects; no SQLite fallback file is created.
- `pnpm docs:build`: documentation site builds successfully.
- Metadata retention regression: more than 50 older log rows exercise coarse pruning. SQLite uses JavaScript whitespace syntax instead of PostgreSQL POSIX `[[:space:]]`; both backends preserve start/continue/exit records.
- `pnpm typecheck`: still blocked only by the pre-existing `src/markdown.test.ts:3` TS7016 for missing `web/markdown.js` declarations; unrelated files were not changed.
- Docker Node 20 validation passed using a temporary Dockerfile with only Debian mirror selection changed to Huawei Cloud (official package-index downloads were too slow; Debian signatures remained verified). Repository defaults retain the original Debian source and domestic base-image registry. Dockerfile includes workspace overrides, pnpm 10, temporary native-build tools and local Node headers. Direct Node/tsx startup avoids runtime Corepack downloads.
- Image runtime smoke: Node v20.20.2, uid 10001, SQLite 3.49.2, healthy HTTP, default SQLite file/workspace present, graceful stop exit 0. Database adapter/config/metadata tests in the Node 20 image: 36 passed. Test containers were removed.

Real multi-process production load testing and cross-database migration are not part of this change. Existing production board and databases were not restarted or modified.
