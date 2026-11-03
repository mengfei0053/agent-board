# Deploy notes

Production is `https://relay.mengfei.tech` on UCloud `101.36.111.17`. The process environment there is `ADMIN_TOKEN` and `BOARD_TOKEN` (Bitwarden item `agent-board-relay 101`). This repository does not deploy that host.

P0 does not deploy this service. The later target is UCloud `101.36.111.17`, on a name under `*.mengfei.tech` (for example `relay.mengfei.tech`).

Do not expose the relay until TLS, authentication, and rate limits are all in place.

- **TLS.** Terminate HTTPS and WSS in nginx or Caddy on the VM. The relay listens on loopback HTTP. It does not terminate TLS.
- **Auth.** Set `ADMIN_TOKEN` and `BOARD_TOKEN` in the process environment. Pair codes come from `POST /auth/pair/create`. Device tokens are bound to `role=phone` and an allow-list of board ids. Revoke device and board credentials with the admin routes. Health returns counts only.
- **Persistence.** Set `RELAY_DB_PATH` and keep its SQLite file on a persistent, access-controlled volume. Only token hashes and authorization metadata are stored, not plaintext tokens or task data.
- **Rate limits.** P0 limits pair attempts and WebSocket frame rate in memory, keyed by the TCP peer. Behind a proxy every client shares that peer address, so the proxy needs its own connection and request limits too.

The board path is relay-only. Do not publish a Tailscale or LAN route to the ThinkBook as a substitute. Agent-board stays on `127.0.0.1:8791` on the ThinkBook. The connector dials the relay. The relay never dials that port and never runs a CLI. P1 maps `cmd.*` onto agent-board inside the connector.

## Rollout for phone settings and archive write

Redeploy this image on UCloud 101 before any ThinkBook idle sync that advertises `archive.write`, `workspace.settings`, or `board.settings`. An older 101 allowlist rejects `board.register` when those names are present, so the board cannot come online. Do not restart or sync the ThinkBook as part of the relay deploy. Confirm 101 is serving this build, then idle-sync the ThinkBook in a separate change.

## Process

`NODE_ENV=production` refuses to start unless `ADMIN_TOKEN`, `BOARD_TOKEN`, and `RELAY_DB_PATH` are set. Keep tokens in the environment, not in the image. Use Node.js 22.13 or newer.

```bash
docker build -t agent-board-relay .
docker volume create agent-board-relay-data
docker run --rm -p 127.0.0.1:8787:8787 \
  -e ADMIN_TOKEN='your-admin-token' \
  -e BOARD_TOKEN='your-board-token' \
  -e RELAY_DB_PATH=/var/lib/agent-board-relay/relay.sqlite \
  -e PAIR_TTL_MS=300000 \
  -v agent-board-relay-data:/var/lib/agent-board-relay \
  agent-board-relay
```

A restart drops pair codes, sockets, task snapshots, logs, and in-flight command results. Device sessions, dynamic board credentials, known boards, and revocations are restored from SQLite. Only the bootstrap credential with the same hash as `BOARD_TOKEN` retains its revocation state; changing that environment token deliberately installs a new bootstrap credential.

On the first rollout, the new database starts empty: existing in-memory phone pairings must be paired again once. If an old dynamic board token was in use, reissue it before deploying and configure the board with the replacement; a valid unchanged bootstrap `BOARD_TOKEN` reconnects without reconfiguration. Do not delete the volume during routine upgrades.

## Admin console

After deploying this build, open `https://relay.mengfei.tech/admin` and log in with `ADMIN_TOKEN`. No separate frontend or database server process is required; the relay uses its local SQLite file. The existing proxy configuration below forwards `/admin`, `/admin/admin.js`, `/admin/admin.css`, and `/api/admin/state` along with the auth routes. If your proxy uses path allowlists, add these paths. Static admin files are public but contain no credentials or service metadata; the state API and all administrative actions require a Bearer admin token.

For a non-Docker deployment, ship `public/` next to `dist/` (the Dockerfile already copies it). Validate that `/admin` loads, an unauthenticated `GET /api/admin/state` returns 401, and `ADMIN_TOKEN` unlocks the state view. Keep HTTPS and reverse-proxy rate limits enabled. Do not paste tokens into URLs.

**Operational warning:** revoking or issuing a board credential invalidates the bootstrap credential and any credentials overlapping the target board IDs. Other boards sharing them may disconnect. Schedule credential changes, update each affected board's `BOARD_TOKEN`, and do not restart a busy local board. With `RELAY_DB_PATH` configured, revocations and dynamically issued tokens survive relay restarts. Back up the SQLite volume and do not run multiple relay replicas against the same file.

## TLS later

nginx:

```nginx
server {
  listen 443 ssl;
  server_name relay.mengfei.tech;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

Caddy:

```caddy
relay.mengfei.tech {
  reverse_proxy 127.0.0.1:8787
}
```

Phones and the ThinkBook connector then use `https://relay.mengfei.tech` and `wss://relay.mengfei.tech/v1/ws`.
