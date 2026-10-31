# agent-board relay

Node WebSocket/HTTP relay between the Android app and the ThinkBook connector. It authenticates devices, routes by `boardId`, and stores command idempotency keys. It does not spawn agents and it does not call the board.

## Run

```bash
cd relay
npm install
cp .env.example .env   # set RELAY_SETUP_TOKEN
npm test
RELAY_SETUP_TOKEN=replace-me npm start
```

`GET /health` on the listen port. Register a board with `POST /boards` and the setup token, then point the connector at the returned `boardToken`. The phone pairs with `POST /auth/pair` after the connector (or you) calls `POST /auth/pair/create`.

Wire format: [../PROTOCOL.md](../PROTOCOL.md).

## Docker

```bash
docker build -t agent-board-relay relay
docker run --rm -e RELAY_SETUP_TOKEN=replace-me -p 127.0.0.1:8787:8787 agent-board-relay
```

Put TLS in front before publishing the port. Do not point the relay at `127.0.0.1:8791` on the ThinkBook; that is the connector's job.
