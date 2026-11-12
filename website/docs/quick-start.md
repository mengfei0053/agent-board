---
sidebar_position: 2
title: 快速开始
---

推荐在本机以单实例运行看板，默认使用 SQLite，无需另装数据库；也可显式选择 PostgreSQL。任务运行所需的 Agent CLI 需要安装在本机，且能够从 `PATH` 找到。

## 准备环境

- Node.js 20 或更高版本、pnpm。SQLite 使用 `better-sqlite3` 11.x，需允许其原生依赖构建。
- 仅选择 PostgreSQL 时需要已有的 PostgreSQL，或 Docker 和 Docker Compose。
- 按需安装 pi、Claude Code、Cursor CLI、Devin CLI、Codex CLI 或 Kimi Code CLI，并完成对应的登录配置。

## 启动看板

### 本机 SQLite（新安装推荐）

**已有 PostgreSQL 用户必须保留原来的显式 PG `DATABASE_URL`，不要执行下面的 `unset`。** 在项目根目录执行：

```bash
pnpm install
unset DATABASE_URL  # 仅新安装 / 确认选择独立 SQLite 数据库时
pnpm dev
```

打开 [http://127.0.0.1:8791](http://127.0.0.1:8791)，添加工作区后即可创建任务。

`DATABASE_URL` 未设置、空字符串或纯空白时，默认使用解析后的绝对路径 `DATA_DIR/agent-board.db`；`DATA_DIR` 缺省为仓库 `data/`。也可以显式设置：

| `DATABASE_URL` | 含义 |
| --- | --- |
| `sqlite:./relative.db` | 相对进程 cwd，不相对 `DATA_DIR` |
| `sqlite:/absolute/path.db` | 指定绝对路径 |
| `sqlite::memory:` | 内存数据库，进程退出即丢失数据 |
| `postgres:…` / `postgresql:…` | 使用指定 PostgreSQL，保持原行为 |

切换数据库看到的是独立数据；不会双写，不自动迁移 PG 数据，也不会在 PG 连接失败时 fallback 到 SQLite。旧 `DATA_DIR/db.json`（默认 `data/db.json`）在启动时一次性导入当前选择的后端，并归档为 `db.json.migrated-*`。

SQLite 开启外键（FK）、WAL、5 秒 `busy_timeout`，单进程内事务串行执行。数据库文件不能放在网络共享盘；备份请停止服务后复制文件，在线备份需正确处理 WAL，不能只复制正在使用的主 `.db` 文件。业务层有内存缓存，因此使用 PG 也不代表已支持多实例一致性。

### 可选 PostgreSQL

已有 PG 可直接设置其显式 URL 后运行 `pnpm dev`。若使用 Compose 提供的 PG，先在项目根目录执行 `cp -n .env.example .env`，编辑 `.env`，将 `POSTGRES_PASSWORD` 改为随机的 URL-safe 长密码，然后启动数据库和本机看板：

```bash
docker compose up -d postgres
export DATABASE_URL='postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/agent_board'
pnpm install
pnpm dev
```

将连接串中的 `<POSTGRES_PASSWORD>` 替换为 `.env` 中设置的密码。打开 [http://127.0.0.1:8791](http://127.0.0.1:8791)，添加工作区后即可创建任务。

现有 Compose 仍专用 PostgreSQL，不提供 SQLite 模式。也可以通过 `docker compose up -d --build` 启动整个应用；默认应用镜像不包含 Agent CLI 和登录凭证，因此容器中的任务执行需要自行配置。完整部署及环境变量说明见 [项目 README](https://github.com/mengfei0053/agent-board#readme)。
