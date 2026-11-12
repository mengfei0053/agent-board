# agent-board — Hono + static web UI
FROM docker.m.daocloud.io/library/node:20-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.34.9 --activate

# Include dependency overrides and native-build policy when using the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Compile SQLite locally if prebuilt binary downloads are unavailable.
# Official Node images already include matching headers under /usr/local.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm_config_nodedir=/usr/local pnpm install --frozen-lockfile \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

RUN useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin app \
 && mkdir -p /app/data/logs /app/data/uploads \
 && chown -R app:app /app

ENV NODE_ENV=production
ENV PORT=8791
EXPOSE 8791

# tsx is in devDependencies; start directly without runtime Corepack downloads.
# The process is not root. Database role in Compose is still the configured
# POSTGRES_USER (superuser on a fresh volume until you ALTER it).
USER app
CMD ["node", "--import", "tsx", "src/server.ts"]
