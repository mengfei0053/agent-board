# agent-board

本机 Web 看板：新建并管理 **pi / Claude Code / Cursor CLI** 正在跑的任务。

## 要求

- Node 20+（ThinkBook 已有）
- 本机已安装并可在 PATH 里找到：`pi`、`claude`、`agent`

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
```

浏览器打开 http://127.0.0.1:8791

首次启动若存在 `data/db.json`，会自动迁移到 Postgres，并将 JSON 改名为 `db.json.migrated-*`。

## 能力（v0.1）

- 创建任务并在指定 cwd 启动对应 CLI（非交互、可脚本化模式）
- 列表 / 详情 / 实时日志（SSE）
- 停止任务
- Webhook 新建草稿 / Todo（需 `AGENT_BOARD_WEBHOOK_SECRET`，见 ARCHITECTURE）

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)
