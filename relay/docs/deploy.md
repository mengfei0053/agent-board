# Deploy notes

Production is `https://relay.mengfei.tech` on UCloud `101.36.111.17`. The process environment there is `ADMIN_TOKEN` and `BOARD_TOKEN` (Bitwarden item `agent-board-relay 101`). This repository does not deploy that host.

P0 does not deploy this service. The later target is UCloud `101.36.111.17`, on a name under `*.mengfei.tech` (for example `relay.mengfei.tech`).

Do not expose the relay until TLS, authentication, and rate limits are all in place.

- **TLS.** Terminate HTTPS and WSS in nginx or Caddy on the VM. The relay listens on loopback HTTP. It does not terminate TLS.
- **Auth.** Set `ADMIN_TOKEN` and `BOARD_TOKEN` in the process environment. Pair codes come from `POST /auth/pair/create`. Device tokens are bound to `role=phone` and an allow-list of board ids. Revoke device and board credentials with the admin routes. Health returns counts only.
- **Rate limits.** P0 limits pair attempts and WebSocket frame rate in memory, keyed by the TCP peer. Behind a proxy every client shares that peer address, so the proxy needs its own connection and request limits too.

The board path is relay-only. Do not publish a Tailscale or LAN route to the ThinkBook as a substitute. Agent-board stays on `127.0.0.1:8791` on the ThinkBook. The connector dials the relay. The relay never dials that port and never runs a CLI. P1 maps `cmd.*` onto agent-board inside the connector.

## Rollout for phone settings and archive write

Redeploy this image on UCloud 101 before any ThinkBook idle sync that advertises `archive.write`, `workspace.settings`, or `board.settings`. An older 101 allowlist rejects `board.register` when those names are present, so the board cannot come online. Do not restart or sync the ThinkBook as part of the relay deploy. Confirm 101 is serving this build, then idle-sync the ThinkBook in a separate change.

## Process

`NODE_ENV=production` refuses to start unless `ADMIN_TOKEN` and `BOARD_TOKEN` are set. Keep them in the environment, not in the image.

```bash
docker build -t agent-board-relay .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e ADMIN_TOKEN='your-admin-token' \
  -e BOARD_TOKEN='your-board-token' \
  -e PAIR_TTL_MS=300000 \
  agent-board-relay
```

A restart drops every pair code, device token, and socket.

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
