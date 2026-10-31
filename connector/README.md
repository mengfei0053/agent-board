# Agent-board connector

In the agent-board monorepo this package lives in `connector/` and the relay lives in `relay/`. Run the relay commands below from `relay/`. Credentials are `ADMIN_TOKEN` and `BOARD_TOKEN` (Bitwarden item `agent-board-relay 101`, live host `https://relay.mengfei.tech`).

Side process for the machine that runs agent-board. It dials the relay, registers as a board, and maps phone commands onto local HTTP. The relay never dials `127.0.0.1:8791`.

`cmd.create` requires `agent` (`pi`, `claude`, `cursor`, `devin`, or `codex`) and a local `cwd`. That becomes `POST /api/tasks` with `{ kind, prompt, title, cwd, start: true }`. `cmd.stop` and `cmd.continue` call `/api/tasks/:id/stop` and `/continue`. The connector reads ThinkBook `GET /api/events` and sends `evt.snapshot` after every successful `board.register`.

`evt.task.done` is sent once per task, the first time status enters `succeeded`, `failed`, or `stopped`. `archived` is not a completion. A reconnect registers again, takes the relay's new generation, resets `seq`, and sends a fresh snapshot without repeating old completion events.

The board token is not written to logs. `BOARD_BASE_URL` must be loopback HTTP.

## Run with the local relay

Terminal 1, from the repo root:

```bash
npm install
npm run dev
```

Copy the printed `ADMIN_TOKEN` and `BOARD_TOKEN`.

Terminal 2:

```bash
npm install --prefix connector
RELAY_WS_URL=ws://127.0.0.1:8787/v1/ws \
BOARD_ID=thinkbook-main \
BOARD_TOKEN="$BOARD_TOKEN" \
npm start --prefix connector
```

`BOARD_BASE_URL` defaults to `http://127.0.0.1:8791`. Point it at a mock only in tests.

Terminal 3:

```bash
npm run fake-phone -- --admin "$ADMIN_TOKEN" --board thinkbook-main
```

## Tests

```bash
npm test --prefix connector
```

That starts the real relay, a loopback mock of agent-board, and this connector. From the repo root, `npm test` and `npm run e2e` still cover the relay and the fake connector only.

## Env

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_WS_URL` | required | Relay socket, for example `ws://127.0.0.1:8787/v1/ws`. |
| `BOARD_ID` | required | Board id sent in `board.register`. |
| `BOARD_TOKEN` | required | Credential for that register. Not printed. |
| `BOARD_BASE_URL` | `http://127.0.0.1:8791` | Loopback agent-board. Non-loopback URLs are rejected. |
| `BOARD_LABEL` | `ThinkBook` | Label stored by the relay. |
| `RECONNECT_MIN_MS` | `500` | First delay after the relay socket drops. |
| `RECONNECT_MAX_MS` | `15000` | Cap for exponential backoff. |
| `HTTP_TIMEOUT_MS` | `15000` | Local board HTTP timeout. |

## Board HTTP this process expects

| Call | Use |
| --- | --- |
| `POST /api/tasks` | Create. Response is the task or `{ task }`. |
| `POST /api/tasks/:id/stop` | Stop. |
| `POST /api/tasks/:id/continue` | Continue. |
| `GET /api/tasks` | `{ tasks: [...] }` or an array, used for the snapshot. |
| `GET /api/events` | SSE. Names are `hello`, `task_upsert`, `task_delete`, `task_log`, `workspace_upsert`, `workspace_delete`, and `ping`. |

Board statuses `draft` and `blocked` become relay `queued` and `paused`. `succeeded`, `failed`, and `stopped` are terminal. `archived` is left out of the hot snapshot. If that task was already on the active list, the connector sends a fresh snapshot without it and does not emit `evt.task.done`. `cmd.archive.list` returns one read-only page. Optional `workspaceId` filters that page before the cursor. `board.register` advertises `archive.list`, `archive.write`, `workspace.settings`, and `board.settings`. `cmd.archive`, `cmd.workspace.get`, `cmd.workspace.update`, `cmd.settings.get`, and `cmd.settings.put` call the same board routes as the web API. `cmd.settings.put` rejects `clear: true`. `cmd.archive` archives only a terminal task and acks `{ archived: true, taskId }` with no hot-list task. The public relay does not forward those command types until its command allowlist is updated.

SSE mapping:

| Board event | Relay |
| --- | --- |
| `hello` | `evt.snapshot` from `tasks`, plus thin `workspaces` (`id`, `name`, `path`, `isGit`). `isGit` comes from the board eligibility HTTP, not from git on this machine. |
| `task_upsert` | `evt.task`, and `evt.task.done` on the first transition to `succeeded`, `failed`, or `stopped`. |
| `task_log` | `evt.log`. The line is truncated to 8000 characters. `kind` on the task is sent as `agent`. |
| `task_delete` | The task is removed and a new `evt.snapshot` is sent. Delete is not a completion. |
| `workspace_upsert`, `workspace_delete`, `ping` | Ignored. |

## Risks

Create fails closed without `cwd`. `useGitWorktree: true` is forwarded on `POST /api/tasks`; `false` and any omission are left off the body. A non-boolean is `bad_request`.

`GET /api/workspaces` and `GET /api/workspaces/:id/git-worktree-eligibility` fill the snapshot. `hello`, `workspace_upsert`, and `workspace_delete` refresh that list. `task_delete` drops the task and sends another snapshot, and it does not clear workspaces. If the workspace list or an eligibility check fails, `isGit` is false. A failed refresh does not keep the previous `isGit` bit.

The create idempotency map is in memory only. The same key in one connector run does not POST twice. After a restart, a lost ack can create another task and another worktree. That cross-restart case is not covered.
