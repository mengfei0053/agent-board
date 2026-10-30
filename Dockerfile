# agent-board — Hono + static web UI
FROM docker.m.daocloud.io/library/node:20-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

RUN mkdir -p /app/data/logs /app/data/uploads

ENV NODE_ENV=production
ENV PORT=8791
EXPOSE 8791

# tsx is in devDependencies; image installs full lockfile so `pnpm start` works
CMD ["pnpm", "start"]
