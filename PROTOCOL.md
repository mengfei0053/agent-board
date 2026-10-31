# Agent-board relay protocol (v1)

The phone talks only to the relay. The ThinkBook connector dials the relay. The relay never dials `127.0.0.1:8791` and never runs a CLI. There is no direct-to-board path.

Every WebSocket message is one JSON object:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Protocol version. |
| `id` | string | Sender id, 1–100 visible ASCII characters. |
| `type` | string | Message type. |
| `ts` | number | Unix milliseconds. |
| `payload` | object | Message body. Unknown fields are ignored and not forwarded. |

`ack` and `err` set `payload.ref` to the id they answer. Command results also set `payload.stage`:

| Stage | Meaning |
| --- | --- |
| `accepted` | The relay stored the command and forwarded it. The board has not finished. |
| `executed` | The board accepted the command. |
| `failed` | The board or the relay rejected it after it was stored. |
| `timeout` | The board did not answer in time. Call `cmd.lookup`. Do not send the command again with the same key. |
| `unknown` | `cmd.lookup` found no record. |

A command that fails before it is stored (`board_offline`, `forbidden`, `unauthorized`) is an `err` and does not consume the idempotency key.

## REST

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Counts only. No board ids and no tokens. |
| `POST` | `/auth/pair/create` | `Authorization: Bearer $ADMIN_TOKEN` | `{ "boardIds": ["thinkbook-main"], "ttlMs": 300000 }` |
| `POST` | `/auth/pair` | pair code | `{ "pairCode": "pc_…", "deviceName": "Pixel 8" }` |
| `POST` | `/auth/refresh` | device token | `{ "deviceToken": "dt_…" }` |
| `POST` | `/auth/revoke/device` | admin | `{ "deviceId": "dev_…" }` |
| `POST` | `/auth/revoke/board` | admin | `{ "boardToken": "…" }` or `{ "boardId": "thinkbook-main" }` |
| `POST` | `/auth/board/issue` | admin | `{ "boardIds": ["thinkbook-main"] }` |

Only the admin path creates pair codes. A code is high-entropy (`pc_` plus 32 random bytes), expires at `PAIR_TTL_MS` (default 5 minutes, and `ttlMs` cannot be longer), and is deleted on first successful pair. Pair attempts are rate-limited per TCP peer (`PAIR_ATTEMPT_LIMIT` / `PAIR_WINDOW_MS`).

Pair success:

```json
{
  "deviceId": "dev_0123abcd",
  "deviceToken": "dt_example",
  "role": "phone",
  "boardIds": ["thinkbook-main"],
  "expiresAt": 1761890300000
}
```

The device token is bound to that `deviceId`, `role: "phone"`, and those board ids. Refresh rotates the token and keeps the binding. Revoke drops it immediately and closes the socket.

`/health` is unauthenticated and looks like:

```json
{ "ok": true, "service": "agent-board-relay", "protocol": 1, "uptimeSec": 0, "boardsOnline": 0, "phonesOnline": 0, "pairedDevices": 0 }
```

## WebSocket

Connect to `/v1/ws`. The first frame is `board.register` or `client.hello`. Tokens are not put in the URL.

| Type | From | To | Purpose |
| --- | --- | --- | --- |
| `board.register` | board | relay | Bind this socket to `boardId` with a board token. Returns `generation`. |
| `client.hello` | phone | relay | Present a device token. |
| `board.list` | phone | relay | Boards this phone is allowed to see. Other boards are omitted. |
| `sub.tasks` | phone | relay | `evt.task`, `evt.snapshot`, `evt.gap`. Optional `afterSeq`. |
| `sub.logs` | phone | relay | `evt.log`. |
| `cmd.create` | phone | board | Create a task. The P2 create-task command. |
| `cmd.continue` | phone | board | Resume a task. |
| `cmd.stop` | phone | board | Stop a task. The connector emits `evt.task.done` once. |
| `cmd.workspace.create` | phone | board | Create a workspace (`name` + `path`). |
| `cmd.workspace.delete` | phone | board | Delete a workspace. Refuses the default workspace and any workspace that still has tasks. |
| `cmd.detail` | phone | board | Read one task's detail card, including an archived task. Does not change the task. |
| `cmd.archive.list` | phone | board | One page of archived tasks. Not part of `evt.snapshot`. Optional `workspaceId` is applied by the board before the page. |
| `cmd.archive` | phone | board | Archive one terminal task. Capability `archive.write`. The public relay does not forward this type until the wave-2 command allowlist. |
| `cmd.workspace.get` | phone | board | Read one workspace, including settings and a git summary. Capability `workspace.settings`. Not forwarded by the public relay until wave 2. |
| `cmd.workspace.update` | phone | board | Update name, path, and replacement settings. Same capability. Not forwarded until wave 2. |
| `cmd.settings.get` | phone | board | Read `GET /api/settings`. Capability `board.settings`. Not forwarded until wave 2. |
| `cmd.settings.put` | phone | board | Partial settings write. Rejects `clear: true`. Not forwarded until wave 2. |
| `cmd.lookup` | phone | relay | Read the stored result of an idempotency key. |
| `evt.task` | board | task subscribers | Task state changed. |
| `evt.log` | board | log subscribers | One log line. |
| `evt.snapshot` | board | task subscribers | Full task list at `version` (equal to `seq`). |
| `evt.task.done` | board | online phones allowed for that board | First transition to a terminal status. |
| `evt.gap` | relay | task subscribers | The phone should resync from a snapshot. |
| `ack` / `err` | either | requester | Result. |

Each successful `board.register` bumps `generation` and resets `seq` to 0. Events carry a monotonic `seq` for that generation and an `eventId`. The relay drops an event it has already applied with the same `eventId`. A hole in `seq` is `seq_gap`: the event is not applied, current subscribers get `evt.gap`, and that gap stays until the next contiguous event. A later `sub.tasks` receives `evt.gap` before the cached snapshot.

`POST /auth/board/issue` revokes every earlier credential that could register those boards, including the bootstrap `BOARD_TOKEN`. The new token is the one that can register them. `POST /auth/revoke/board` with a `boardId` does the same for that id.

On `sub.tasks` the relay sends the cached snapshot, then `evt.task` events newer than that snapshot. Pass `afterSeq` to skip task events the phone already applied. `evt.log` is not included; it is replayed only by `sub.logs`. `evt.task.done` is not replayed. Terminal status is in the snapshot. A live `evt.task.done` is best-effort for phones whose device token still verifies at send time. A refreshed, revoked, or expired token closes the old socket and does not receive later events. Clients dedupe a live `evt.task.done` by `eventId`.

If the board is offline, `cmd.*` returns `err` `board_offline` and is not queued.

WebSocket frames are limited to `WS_MESSAGES_PER_SEC` (default 40) per socket. Excess frames get `rate_limited`.

## cmd.create

```json
{
  "v": 1,
  "id": "phone-create-1",
  "type": "cmd.create",
  "ts": 1761890000000,
  "payload": {
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-req-7f3a",
    "title": "Fix login flake",
    "prompt": "Investigate the flaky login test and propose a fix.",
    "agent": "cursor",
    "cwd": "/home/me/src/app"
  }
}
```

`idempotencyKey` is required, 8–80 visible ASCII characters, and is scoped to the board and the command type. `agent` and `cwd` are optional. Optional `workspaceId` files the task in that workspace and uses the workspace path as cwd, the same as web `POST /api/tasks`. Omit it to keep path matching. Optional `useGitWorktree` is a strict boolean. Omit it or send `false` for the usual create. `true` asks the board to make a git worktree from `cwd` when that path is a git work tree root. The relay forwards only `true` and rejects any other type. The relay does not create worktrees.

The relay answers `accepted` immediately, then `executed` when the board acks:

```json
{
  "v": 1,
  "id": "relay-ack-accepted",
  "type": "ack",
  "ts": 1761890000010,
  "payload": {
    "ref": "phone-create-1",
    "stage": "accepted",
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-req-7f3a",
    "commandId": "cmd-accept-1"
  }
}
```

```json
{
  "v": 1,
  "id": "relay-ack-executed",
  "type": "ack",
  "ts": 1761890001100,
  "payload": {
    "ref": "phone-create-1",
    "stage": "executed",
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-req-7f3a",
    "commandId": "cmd-accept-1",
    "task": {
      "id": "task_01",
      "title": "Fix login flake",
      "status": "queued",
      "updatedAt": 1761890001100,
      "agent": "cursor"
    }
  }
}
```

The board should ack when it accepts the work. Completion is `evt.task.done`, not this ack. The same key inside `IDEMPOTENCY_TTL_MS` returns the stored stage and does not forward again. After `timeout` or `failed`, call lookup instead of creating again:

```json
{
  "v": 1,
  "id": "phone-lookup-1",
  "type": "cmd.lookup",
  "ts": 1761890009000,
  "payload": {
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-req-7f3a",
    "cmd": "cmd.create"
  }
}
```

```json
{
  "v": 1,
  "id": "relay-ack-lookup",
  "type": "ack",
  "ts": 1761890009010,
  "payload": {
    "ref": "phone-lookup-1",
    "stage": "timeout",
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-req-7f3a",
    "commandId": "cmd-accept-1",
    "code": "timeout",
    "message": "board did not acknowledge the command"
  }
}
```

`cmd.continue` and `cmd.stop` use the same ack layers. Both require `idempotencyKey`. Optional `prompt` on `cmd.continue` is the extra instruction from the web task popup. Omit it and the board uses `请基于当前上下文继续完成任务`. `prompt` may contain newlines and is at most 20,000 characters.

`cmd.detail` reads one task for the phone detail screen. It uses the same ack and idempotency key as the other commands. The executed ack's `task` is a full detail card (`detail: "full"`). Opening the screen sends a new key; it does not change the task. An archived task uses the same card with `status: "archived"`. That status is rejected on `evt.snapshot` and `evt.task`, so old phones never see it in the hot list.

`cmd.archive.list` is a read-only page. The phone sends it only after `board.list` shows `capabilities` containing `archive.list` (set on `board.register`). Boards that omit the capability get `err` `unsupported` and the command is not stored. The body is `boardId`, `idempotencyKey`, optional `limit` (1–50, default 20), optional `cursor`, and optional `workspaceId`. The cursor is `updatedAt:id` or `updatedAt:id:revision` (`revision` is 8 hex characters). The embedded dialer accepts both; a cursor from another workspace, or a set that changed, restarts at page 1 (`restarted: true`) instead of skipping rows. When `workspaceId` is present the board filters to that workspace before the limit and the cursor. Omitting it keeps a board-wide page. The executed ack's `archive` is `{ tasks, nextCursor?, restarted? }`. Rows are thin, newest `updatedAt` first, and every `status` is `archived`. A task that moves to archived is removed from the next `evt.snapshot` and does not emit `evt.task.done`. The public relay currently rebuilds this payload and drops `workspaceId` until the wave-2 allowlist forwards it.

`board.register` capabilities are `archive.list`, `archive.write`, `workspace.settings`, and `board.settings`. The public relay accepts those names on register. It does not yet accept the new command types below; a phone that sends them to today's relay gets `bad_type` and the command is not stored. `err` code `archived_readonly` means the task is archived and the board refused continue, stop, start, or a second archive. The web restore path (`POST /api/tasks/:id/move` with `lane: "done"`) stays on the web.

## Board commands added for the phone

These handlers run in the embedded dialer (`src/relay/`) and the standalone connector. They are not in the public relay command allowlist yet.

`cmd.workspace.get` payload: `boardId`, `idempotencyKey`, `workspaceId`. The executed `workspace` is `{ id, name, path, isGit, settings, git }`. `settings` always has `systemPrompt` (string), `skills` (array), and `mcp` (string); empty means unset. `git` is `{ branch, dirty, ahead, behind, detached, repoCount, error }` for the root repository. `ahead` and `behind` are numbers, or null when there is no upstream. A git failure still returns name, path, and settings, with `git.error` set and `isGit` false when the worktree probe fails. There is no file list.

`cmd.workspace.update` payload: `boardId`, `idempotencyKey`, `workspaceId`, `name`, `path`, and `settings` with all three keys. The board uses the same checks as `PATCH /api/workspaces/:id`: a present `settings` object replaces the stored object, and existing tasks keep `task.cwd`. The ack is the same workspace object as get. A failed save does not invent a success.

`cmd.settings.get` payload: `boardId`, `idempotencyKey`. The ack `settings` is the `GET /api/settings` document. Proxy userinfo is `***` and `hasCredential` is set. Do not log that document.

`cmd.settings.put` payload: `boardId`, `idempotencyKey`, plus the same partial body as `PUT /api/settings` (`cliPaths`, `proxyEnv`, `quickPrompts`, `codexSandbox`). `clear: true` is rejected with `bad_request` and writes nothing. A value containing `***` as the URL userinfo keeps the stored secret. The ack is the committed redacted document, not a synthetic success. The board does not write the raw proxy URL into logs, error messages, or the idempotency cache. Omitted groups are left unchanged.

`cmd.archive` payload: `boardId`, `idempotencyKey`, `taskId`. The board allows it only when the status is `succeeded`, `failed`, or `stopped`, under the same task lock as move. `running`, `queued`, and `blocked` return `bad_request` (`task is still running`). `draft` returns `bad_request` (`draft cannot be archived`). An archived task returns `archived_readonly`. The check is repeated inside the lock, so a continue that won the lock is not archived. The executed ack is `{ archived: true, taskId }` and has no `task` field. The next snapshot drops the card. Web `lane: "archived"` can still stop an active card; the phone command cannot.

```text
{
  "v": 1,
  "id": "phone-archive-1",
  "type": "cmd.archive",
  "ts": 1761890006000,
  "payload": {
    "boardId": "thinkbook-main",
    "idempotencyKey": "idem-archive-01",
    "taskId": "task_01"
  }
}
```

```text
{
  "v": 1,
  "id": "board-ack-archive",
  "type": "ack",
  "ts": 1761890006100,
  "payload": {
    "ref": "phone-archive-1",
    "stage": "executed",
    "boardId": "thinkbook-main",
    "idempotencyKey": "idem-archive-01",
    "archived": true,
    "taskId": "task_01"
  }
}
```

```json
{
  "v": 1,
  "id": "phone-continue-1",
  "type": "cmd.continue",
  "ts": 1761890002000,
  "payload": {
    "boardId": "thinkbook-main",
    "taskId": "task_01",
    "idempotencyKey": "idem-continue"
  }
}
```

```json
{
  "v": 1,
  "id": "phone-stop-1",
  "type": "cmd.stop",
  "ts": 1761890004000,
  "payload": {
    "boardId": "thinkbook-main",
    "taskId": "task_01",
    "idempotencyKey": "idem-stop-01",
    "reason": "user tapped stop"
  }
}
```

## Workspaces

Selecting a workspace is not a frame. The phone keeps the selection locally, the same way the web board keeps `selectedWorkspaceId`. That selection filters the task list and is the default path for `cmd.create`. The board does not learn about the switch.

`cmd.workspace.create` and `cmd.workspace.delete` use the same ack layers and idempotency key as `cmd.create`. `cmd.lookup` accepts `cmd` `cmd.workspace.create` or `cmd.workspace.delete`.

Create matches `POST /api/workspaces`: `name` (1–200 characters) and an absolute local `path`. The board resolves the path and assigns the id. The executed ack includes `workspace`: `{ id, name, path, isGit }`. `isGit` is the same eligibility bit as on a snapshot. A repeated key returns that workspace and does not create another.

```json
{
  "v": 1,
  "id": "phone-ws-create-1",
  "type": "cmd.workspace.create",
  "ts": 1761890003000,
  "payload": {
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-ws-7f3a",
    "name": "App",
    "path": "/home/me/src/app"
  }
}
```

```json
{
  "v": 1,
  "id": "relay-ack-ws",
  "type": "ack",
  "ts": 1761890003100,
  "payload": {
    "ref": "phone-ws-create-1",
    "stage": "executed",
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-ws-7f3a",
    "commandId": "cmd-ws-1",
    "workspace": { "id": "ws_app", "name": "App", "path": "/home/me/src/app", "isGit": true }
  }
}
```

Delete matches `DELETE /api/workspaces/:id`. The board refuses with `bad_request` when the id is the default workspace (`cannot delete the default workspace`) or the workspace still has tasks (`workspace still has tasks; move or delete them first`). Tasks are not detached or moved. A successful ack sets `deleted` to that workspace id.

```json
{
  "v": 1,
  "id": "phone-ws-delete-1",
  "type": "cmd.workspace.delete",
  "ts": 1761890003200,
  "payload": {
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-ws-del-1",
    "workspaceId": "ws_app"
  }
}
```

```json
{
  "v": 1,
  "id": "relay-ack-ws-del",
  "type": "ack",
  "ts": 1761890003300,
  "payload": {
    "ref": "phone-ws-delete-1",
    "stage": "executed",
    "boardId": "thinkbook-main",
    "idempotencyKey": "android-ws-del-1",
    "commandId": "cmd-ws-del-1",
    "deleted": "ws_app"
  }
}
```

Offline:

```json
{
  "v": 1,
  "id": "relay-err-offline",
  "type": "err",
  "ts": 1761890000500,
  "payload": {
    "ref": "phone-create-1",
    "stage": "failed",
    "code": "board_offline",
    "message": "board thinkbook-main is not connected",
    "idempotencyKey": "android-req-7f3a"
  }
}
```

## Events

`seq` is the board cursor. `version` on a snapshot equals that event's `seq`.

```json
{
  "v": 1,
  "id": "board-task-1",
  "type": "evt.task",
  "ts": 1761890001500,
  "payload": {
    "boardId": "thinkbook-main",
    "generation": 1,
    "seq": 2,
    "eventId": "board-task-1",
    "task": {
      "id": "task_01",
      "title": "Fix login flake",
      "status": "running",
      "updatedAt": 1761890001500,
      "agent": "cursor"
    }
  }
}
```

```json
{
  "v": 1,
  "id": "board-log-1",
  "type": "evt.log",
  "ts": 1761890001600,
  "payload": {
    "boardId": "thinkbook-main",
    "generation": 1,
    "seq": 3,
    "eventId": "board-log-1",
    "taskId": "task_01",
    "stream": "system",
    "line": "connector accepted create"
  }
}
```

```json
{
  "v": 1,
  "id": "board-snap-1",
  "type": "evt.snapshot",
  "ts": 1761890001700,
  "payload": {
    "boardId": "thinkbook-main",
    "generation": 1,
    "seq": 4,
    "eventId": "board-snap-1",
    "version": 4,
    "capturedAt": 1761890001700,
    "tasks": [
      {
        "id": "task_01",
        "title": "Fix login flake",
        "status": "running",
        "updatedAt": 1761890001700,
        "agent": "cursor"
      }
    ]
  }
}
```

`workspaces` is optional. When present it is a list of at most 50 `{ id, name, path, isGit }` entries. `name` is 1–200 characters. `isGit` is the board's eligibility bit for that workspace path. A frame without `workspaces` is still valid. If any entry is malformed, the snapshot is `bad_request` and is not applied.

Each task may include optional `workspaceId` (1–64 characters: letters, digits, `_`, `.`, `-`). It is the board workspace this task belongs to. `evt.task`, `evt.snapshot` tasks, and the task object on an executed `cmd.create` ack all use it. Frames that omit `workspaceId` stay valid; the phone treats a missing id as unassigned. A present but invalid `workspaceId` is `bad_request` and that frame is not applied.

The same task object may carry the web detail card. All of these fields are optional, and a frame that omits them is still valid:

| Field | Meaning |
| --- | --- |
| `iteration`, `cwd`, `model`, `sessionId`, `startedAt`, `endedAt`, `exitCode`, `pid`, `error`, `worktreeBranch` | The 任务信息 rows. Times are epoch milliseconds. |
| `resumeCommand` | The copyable 继续会话 command. Absent when the task has no session id. |
| `promptPreview`, `outputPreview` | Short text on a snapshot so the list frame stays small. |
| `detail` | `"full"` on `evt.task` and `cmd.detail`. The phone keeps a previously loaded full card when a later snapshot omits it. |
| `prompt`, `output`, `turns`, `sideJobs` | Full card only. `turns` is at most 12 `{ iteration, prompt?, output?, at? }` rows. `sideJobs` is at most 20 `{ id, kind, title, status, summary?, toolName? }`. Text is clipped; `promptTruncated` / `outputTruncated` say so. Newlines are allowed. |

Delete, archive, and draft start stay on the web board. The phone detail uses stop, continue, the resume command, the progress rounds, and the live log tail.

```json
{
  "v": 1,
  "id": "board-snap-ws",
  "type": "evt.snapshot",
  "ts": 1761890001700,
  "payload": {
    "boardId": "thinkbook-main",
    "generation": 1,
    "seq": 4,
    "eventId": "board-snap-ws",
    "version": 4,
    "capturedAt": 1761890001700,
    "tasks": [
      {
        "id": "task_01",
        "title": "Fix login flake",
        "status": "running",
        "updatedAt": 1761890001700,
        "agent": "cursor",
        "workspaceId": "ws_app"
      }
    ],
    "workspaces": [{ "id": "ws_app", "name": "App", "path": "/home/me/src/app", "isGit": true }]
  }
}
```

## evt.task.done

The connector emits this only on the first transition into `succeeded`, `failed`, or `stopped`. The relay fans it out to every phone socket that is online and whose device token includes that `boardId`. It does not require `sub.tasks`. A phone that is offline gets nothing: this path is best-effort. A WebSocket delivery is not proof that a system notification was shown. P2 may post an Android notification from this event and must ignore a repeat of the same `eventId`.

The relay also suppresses a second terminal event for the same task in the same generation, and a retry of the same `eventId`.

```json
{
  "v": 1,
  "id": "board-done-1",
  "type": "evt.task.done",
  "ts": 1761890005000,
  "payload": {
    "boardId": "thinkbook-main",
    "taskId": "task_01",
    "status": "stopped",
    "generation": 1,
    "seq": 5,
    "eventId": "board-done-1",
    "title": "Fix login flake",
    "summary": "Stopped by client"
  }
}
```

`title` and `summary` are optional. P2 can use `title` as the notification title and `summary` or `status` as the body.

Gap:

```json
{
  "v": 1,
  "id": "relay-gap-1",
  "type": "evt.gap",
  "ts": 1761890001800,
  "payload": {
    "boardId": "thinkbook-main",
    "generation": 1,
    "expectedSeq": 3,
    "gotSeq": 5,
    "reason": "seq_gap"
  }
}
```

`reason` is `seq_gap`, `buffer_gap`, `generation_changed`, `ahead`, or `no_snapshot`.

## Session frames

```json
{
  "v": 1,
  "id": "board-register-1",
  "type": "board.register",
  "ts": 1761890000000,
  "payload": {
    "boardId": "thinkbook-main",
    "token": "board-token-value",
    "label": "ThinkBook"
  }
}
```

```json
{
  "v": 1,
  "id": "phone-hello-1",
  "type": "client.hello",
  "ts": 1761890000000,
  "payload": {
    "token": "dt_example",
    "name": "Pixel 8"
  }
}
```

```json
{
  "v": 1,
  "id": "relay-ack-hello",
  "type": "ack",
  "ts": 1761890000005,
  "payload": {
    "ref": "phone-hello-1",
    "stage": "executed",
    "deviceId": "dev_0123abcd",
    "role": "phone",
    "boardIds": ["thinkbook-main"]
  }
}
```

```json
{
  "v": 1,
  "id": "phone-list-1",
  "type": "board.list",
  "ts": 1761890000100,
  "payload": {}
}
```

```json
{
  "v": 1,
  "id": "relay-ack-list",
  "type": "ack",
  "ts": 1761890000110,
  "payload": {
    "ref": "phone-list-1",
    "stage": "executed",
    "boards": [
      {
        "boardId": "thinkbook-main",
        "label": "ThinkBook",
        "online": true,
        "connectedAt": 1761890000000,
        "generation": 1
      }
    ]
  }
}
```

```json
{
  "v": 1,
  "id": "phone-sub-tasks-1",
  "type": "sub.tasks",
  "ts": 1761890000200,
  "payload": {
    "boardId": "thinkbook-main",
    "afterSeq": 4
  }
}
```

```json
{
  "v": 1,
  "id": "phone-sub-logs-1",
  "type": "sub.logs",
  "ts": 1761890000300,
  "payload": {
    "boardId": "thinkbook-main",
    "taskId": "task_01"
  }
}
```

Task status values are `queued`, `running`, `paused`, `succeeded`, `failed`, and `stopped`. Terminal statuses are the last three.

## Memory

Admin token, pair codes, device tokens, board credentials, sockets, idempotency records, and the latest snapshot live in the process only. Used pair codes are deleted. Nothing sensitive is written to disk.
