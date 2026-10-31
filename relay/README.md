# Agent-board relay

In the agent-board monorepo this package is `relay/`. Run the commands below from this directory. Production on `https://relay.mengfei.tech` (UCloud 101, Bitwarden `agent-board-relay 101`) uses `ADMIN_TOKEN` and `BOARD_TOKEN`.

In-memory relay between a phone and the agent-board connector on a ThinkBook.

The phone never talks to the board. The board connector dials out to this relay. Agent-board itself stays on `127.0.0.1:8791` on the ThinkBook; mapping commands onto that HTTP API is P1, inside the connector. This process does not call it and does not run CLIs. There is no Tailscale shortcut.

P0 is the relay, a fake connector, and a fake phone. The Android app is later (Kotlin Compose). It will send `cmd.create` as specified in [PROTOCOL.md](PROTOCOL.md). Completion is `evt.task.done` while the phone socket is online. That delivery is best-effort: receiving the frame is not the same as an Android system notification being shown, and an offline phone is not pushed.

Pair codes, device tokens, board credentials, sockets, idempotency records, and the latest snapshot exist only in process memory. They are not written to disk.

## Public deploy prerequisites

Do not put this process on a public interface until all three are true:

1. **TLS** terminates in nginx or Caddy on the VM. The relay speaks plain HTTP and WebSocket on loopback. See [docs/deploy.md](docs/deploy.md).
2. **Auth** is the admin token, one-time pair codes, device tokens bound to board ids, and a board token. Health returns counts only.
3. **Rate limits** are on. P0 limits pair attempts and WebSocket frames in memory. A reverse proxy should limit connections too, because it is the TCP peer the relay sees.

The later host is UCloud `101.36.111.17` under `*.mengfei.tech`. P0 does not deploy there.

## Run locally

```bash
npm install
npm test
npm run dev
```

`npm run dev` listens on `127.0.0.1:8787`. If `ADMIN_TOKEN` or `BOARD_TOKEN` is unset, the process generates one and prints it once. `NODE_ENV=production` refuses to generate them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind TLS. |
| `PORT` | `8787` | HTTP and WebSocket port. WebSocket path is `/v1/ws`. |
| `ADMIN_TOKEN` | generated | Bearer token for `POST /auth/pair/create`, revoke, and board issue. |
| `BOARD_TOKEN` | generated | Bootstrap credential the connector sends in `board.register`. |
| `PAIR_TTL_MS` | `300000` | Maximum pair-code lifetime. `PAIR_TTL` is accepted as an alias. |
| `TOKEN_TTL_MS` | 7 days | Device token lifetime. Refresh rotates it. |
| `IDEMPOTENCY_TTL_MS` | `600000` | How long a `cmd.*` result is remembered. |
| `CMD_TIMEOUT_MS` | `8000` | How long `accepted` waits before `timeout`. |
| `PAIR_ATTEMPT_LIMIT` | `8` | Pair attempts per `PAIR_WINDOW_MS` per TCP peer. |
| `PAIR_WINDOW_MS` | `60000` | Window for the pair-attempt limit. |
| `WS_MESSAGES_PER_SEC` | `40` | Inbound WebSocket frames per socket. |

Create a pair code (it is not a long-lived env var):

```bash
curl -s -X POST http://127.0.0.1:8787/auth/pair/create \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"boardIds":["thinkbook-main"]}'
```

## Fake end-to-end

```bash
npm test
npm run e2e
```

`npm test` covers auth rejects, pair brute-force, idempotency, timeout lookup, offline commands, unauthorized board ids, `evt.task.done` fan-out, duplicate `eventId`, sequence gaps, and reconnect. `npm run e2e` boots the relay, the fake connector, and fake phones and checks the same loop on the wire.

Two terminals against `npm run dev`:

```bash
npm run fake-board -- --board thinkbook-main --token "$BOARD_TOKEN"
npm run fake-phone -- --admin "$ADMIN_TOKEN" --board thinkbook-main
```

`--observe` on a third terminal waits for `evt.task.done` and does not send commands.

## Examples

`cmd.create`:

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

`evt.snapshot`:

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

`evt.task.done`:

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
