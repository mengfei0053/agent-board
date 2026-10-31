# agent-board connector

Standalone process on the ThinkBook. It registers with the relay using a board token and translates phone commands into the local board HTTP API at `http://127.0.0.1:8791`.

Embedding this into the board process is a separate change. This package stays a sidecar.

## Run

```bash
cd connector
npm install
npm test
RELAY_WS=wss://relay.example/v1/ws \
BOARD_TOKEN=... \
BOARD_ID=thinkbook \
BOARD_URL=http://127.0.0.1:8791 \
npm start
```

`BOARD_URL` defaults to `http://127.0.0.1:8791`. `cmd.create` with `useGitWorktree: true` is forwarded as `POST /api/tasks` with `start: true` and `useGitWorktree: true`.

The phone must not be configured with this URL. It only has the relay. See [../PROTOCOL.md](../PROTOCOL.md).
