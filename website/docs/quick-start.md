---
sidebar_position: 2
title: 快速开始
---

推荐在本机运行看板，并使用 Docker Compose 启动 PostgreSQL。任务运行所需的 Agent CLI 需要安装在本机，且能够从 `PATH` 找到。

## 准备环境

- Node.js 20 或更高版本、pnpm。
- Docker 和 Docker Compose，或已有的 PostgreSQL。
- 按需安装 pi、Claude Code、Cursor CLI、Devin CLI 或 Codex CLI，并完成对应的登录配置。

## 启动看板

在项目根目录执行：

```bash
cp -n .env.example .env
```

编辑 `.env`，将 `POSTGRES_PASSWORD` 改为随机的 URL-safe 长密码，并同步配置 `DATABASE_URL`。然后启动数据库和看板：

```bash
docker compose up -d postgres
export DATABASE_URL='postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/agent_board'
pnpm install
pnpm dev
```

将连接串中的 `<POSTGRES_PASSWORD>` 替换为 `.env` 中设置的密码。打开 [http://127.0.0.1:8791](http://127.0.0.1:8791)，添加工作区后即可创建任务。

也可以通过 `docker compose up -d --build` 启动整个应用；默认应用镜像不包含 Agent CLI 和登录凭证，因此容器中的任务执行需要自行配置。完整部署及环境变量说明见 [项目 README](https://github.com/mengfei0053/agent-board#readme)。
