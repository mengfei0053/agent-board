# agent-board

本机 Agent 看板：左侧**工作区** CRUD，右侧四列泳道（草稿 / Todo / 进行中 / 已完成）；新建草稿与 Todo 自动使用当前选中工作区路径。支持 **pi / Claude Code / Cursor CLI**，实时日志（SSE）、停止 / 继续任务、深浅色主题。

## 界面预览

主界面（侧栏工作区 + 泳道），深色：

![主界面 · 深色](docs/screenshots/board-dark.png)

主界面，浅色：

![主界面 · 浅色](docs/screenshots/board-light.png)

任务详情弹窗（状态、输出、停止 / 继续）：

![任务详情 · 深色](docs/screenshots/detail-dark.png)

顶栏可切换主题：跟随系统 → 浅色 → 深色（偏好写入 `localStorage`）。

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 工作区 | 左侧增删改查；任务归属工作区；cwd = 工作区 path |
| 草稿 / Todo | 「新建草稿」仅入库；「新建 Todo」创建并开跑；拖拽泳道可改状态 |
| 进行中 / 已完成 | SSE 实时刷新卡片与日志；可停止进程 |
| 继续任务 | 终态任务可按 CLI session 续跑，迭代次数 +1 |
| Webhook | `POST /api/hooks/tasks`（需 `AGENT_BOARD_WEBHOOK_SECRET`） |
| 存储 | Postgres（`DATABASE_URL`） |

更多设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)，HTTP 接口见运行中的 [/docs](http://127.0.0.1:8791/docs)。

## 要求

- Node 20+
- 本机 PATH 中可找到：`pi`、`claude`、`agent`（按你实际使用的 Agent）
- Postgres（默认 `postgresql://postgres:postgres@127.0.0.1:5432/agent_board`）

## 启动

```bash
cd ~/projects/agent-board
pnpm install   # 或 npm i / bun i

# Postgres（默认连本机 docker postgres:5432 / 库 agent_board）
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_board'
# 若库不存在：
#   PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -c 'CREATE DATABASE agent_board;'
# 或使用项目内隔离实例：docker compose up -d  → 端口 5433
#   export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5433/agent_board'

pnpm dev
# 或生产式：pnpm start   # 默认 PORT=8791
```

浏览器打开 http://127.0.0.1:8791

首次启动若存在 `data/db.json`，会自动迁移到 Postgres，并将 JSON 改名为 `db.json.migrated-*`。

## 重新截图（可选）

服务需已在 `8791` 运行，本机有 Google Chrome：

```bash
pnpm exec node scripts/capture-screenshots.mjs
```

截图输出到 `docs/screenshots/`。

## 致谢 / 友情链接

- [LINUX DO](https://linux.do/) — 感谢社区氛围与开源推广支持
