# agent-board relay protocol

The phone never opens the ThinkBook board. It talks only to the relay. The connector, on the ThinkBook, is the only process that calls `http://127.0.0.1:8791`.

```
Android  --WSS /v1/ws-->  relay  <--WSS /v1/ws--  connector  --HTTP-->  agent-board
```

Messages are JSON envelopes:

```json
{ "v": 1, "id": "m…", "type": "cmd.create", "ts": 1710000000000, "payload": {} }
```

`id` is 1–100 visible ASCII characters. Unknown payload fields are ignored.

## HTTP

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| GET | `/health` | none | `{ "ok": true, "boardsOnline": 0 }` |
| POST | `/boards` | `Authorization: Bearer $RELAY_SETUP_TOKEN` | `{ "boardId", "label" }` → `{ "boardToken" }` |
| POST | `/auth/pair/create` | board token | `{ "pairCode", "expiresAt" }` one-time, 5 minutes, 5 attempts |
| POST | `/auth/pair` | none | `{ "pairCode", "deviceName" }` → `{ "deviceId", "deviceToken", "role": "phone", "boardIds", "expiresAt" }` |
| POST | `/auth/refresh` | none | `{ "deviceToken" }` rotates the token |

`role` must be `phone`. A used or expired pair code is rejected. The setup token is not a device token.

## WebSocket `/v1/ws`

Phone, first frame: `client.hello` `{ "token", "name" }`.  
Connector, first frame: `board.register` `{ "token", "boardId" }`.  
A bad token is `err` `unauthorized` or `revoked`, then the socket closes.

| type | From | Payload |
| --- | --- | --- |
| `board.list` | phone | ack `{ "boards": [{ "boardId", "label", "online", "generation" }] }` |
| `sub.tasks` | phone | `{ "boardId" }` |
| `sub.logs` | phone | `{ "boardId", "taskId"? }` |
| `cmd.create` | phone | `{ "boardId", "idempotencyKey", "title", "prompt", "agent", "cwd", "useGitWorktree"? }` |
| `cmd.continue` / `cmd.stop` | phone | `{ "boardId", "taskId", "idempotencyKey", "reason"? }` |
| `cmd.lookup` | phone | `{ "boardId", "idempotencyKey", "cmd" }` |
| `cmd.result` | connector | `{ "idempotencyKey", "stage": "executed"|"failed"|"timeout", "task"?, "message"? }` |
| `evt.snapshot` | connector | `{ "boardId", "generation", "seq", "tasks", "workspaces" }` |
| `evt.task` / `evt.log` / `evt.task.done` / `evt.gap` | connector | forwarded only to phones subscribed to that board |

`agent` is `pi`, `claude`, `cursor`, `devin`, or `codex`. `useGitWorktree: true` is sent only when the phone checkbox is on; otherwise the field is omitted. The connector maps that onto the board's `POST /api/tasks` with `start: true`.

Acknowledgements use `ack` or `err` and a `stage`:

- `accepted` — relay stored the command and is waiting for the board. The phone must not send a second create.
- `executed` — the board accepted it.
- `failed` / `timeout` — stored. The phone looks the same key up; it does not mint a new create.
- `unknown` — the relay has no record.
- `err` codes `board_offline`, `forbidden`, `unauthorized`, `bad_request`, `rate_limited` are **not** stored. The same idempotency key may be sent again.

`evt.task.done` is emitted once per `eventId`, only when a task first reaches `succeeded`, `failed`, or `stopped`. The phone notifies only while the socket is open.

Audit records are `{ ts, type, id, boardId }`. Prompts, titles, and paths are not written to the audit log.

## Deploy

Relay listens on `127.0.0.1`. Terminate TLS in front of it (`wss://` and `https://`) before any public name such as `relay.mengfei.tech`. This repository does not deploy to UCloud. The connector stays on the ThinkBook next to the board and is not part of the relay image.

See [relay/README.md](relay/README.md) and [connector/README.md](connector/README.md).
