# agent-board

本机 Agent 看板：左侧**工作区** CRUD，右侧五列泳道（草稿 / Todo / 进行中 / 已完成 / 归档）；新建草稿与 Todo 自动使用当前选中工作区路径。支持 **pi / Claude Code / Cursor CLI / Devin CLI / Codex CLI**，实时日志（SSE）、停止 / 继续任务、深浅色主题。

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
| 工作区 | 左侧增删改查；右键菜单（设置 / 编辑 / 删除）；空间设置页可配提示词 / skills / MCP；cwd = 工作区 path。选中工作区后显示该路径下全部 Git 仓库的分支、领先/落后与变更文件（只读） |
| 草稿 / Todo | 「新建草稿」仅入库；「新建 Todo」创建并开跑；拖拽泳道可改状态。工作区是带可用 HEAD 的 git 根目录时，新建弹窗可选「在 git worktree 中启动」（默认关） |
| Git worktree | 勾选后在 `<工作区>/.agent-board/worktrees/<任务 id>` 创建分支 `agent-board/<任务 id>`，任务 cwd 指向该目录。删除任务时移除干净的 worktree 目录；有未提交改动则保留并提示。请自行将 `.agent-board/` 写入 `.gitignore` 或本机 excludesfile，看板不会修改仓库的 ignore 文件 |
| 进行中 / 已完成 / 归档 | SSE 实时刷新卡片与日志；可停止进程；已完成卡片可归档 |
| 继续任务 | 终态任务可按 CLI session 续跑，迭代次数 +1 |
| Webhook | `POST /api/hooks/tasks`（需 `AGENT_BOARD_WEBHOOK_SECRET`） |
| 存储 | Postgres（`DATABASE_URL`） |

更多设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)，HTTP 接口见运行中的 [/docs](http://127.0.0.1:8791/docs)。

## 要求

- Node 20+（本机开发）或 Docker / Docker Compose（一键启动）
- 本机 PATH 中可找到：`pi`、`claude`、`agent`、`devin`、`codex`（按你实际使用的 Agent；见下方「Docker 与 CLI」）
- Postgres（本机或 Compose 内置）

## 一键启动（Docker Compose）

```bash
cd ~/projects/agent-board   # 或你的 clone 路径
cp -n .env.example .env
# 必填：把 POSTGRES_PASSWORD 换成随机 URL-safe 长密码，并同步 DATABASE_URL。
# 占位符 replace-with-a-long-random-password 不是强密码。已有 volume 需 ALTER USER。

docker compose up -d --build
```

浏览器打开 **http://127.0.0.1:8791**

| 服务 | 容器内 | 宿主机映射 |
| --- | --- | --- |
| `app`（看板） | `8791` | **127.0.0.1:8791** |
| `postgres` | `5432` | **127.0.0.1:5433**（避免占本机已有 5432，且不向局域网发布） |

常用命令：

```bash
docker compose logs -f app      # 看看板日志
docker compose down             # 停掉（保留 postgres volume）
docker compose down -v          # 停掉并删库数据 volume
```

仅起数据库、看板仍在本机跑：

```bash
docker compose up -d postgres
# 密码来自 .env 的 POSTGRES_PASSWORD（须 URL-safe）。端口只绑定 127.0.0.1。
export DATABASE_URL='postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/agent_board'
pnpm install && pnpm dev
```

数据卷：

- Postgres：named volume `agent_board_pg`
- 任务日志等：绑定挂载 `./data` → 容器 `/app/data`

### 环境变量

| 变量 | 默认 / Compose 行为 | 说明 |
| --- | --- | --- |
| `PORT` | `8791` | HTTP 端口 |
| `HOST` | 本机默认 `127.0.0.1`；Compose 内 `0.0.0.0` | 监听地址（容器内需 `0.0.0.0` 才能映射端口） |
| `DATABASE_URL` | Compose 内由 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` 拼出，不再默认 `postgres:postgres`；本机未设置时回退到本机 `127.0.0.1:5432` 的开发库 | Postgres 连接串 |
| `DATA_DIR` / `UPLOADS_DIR` | 仓库 `data/` 与 `data/uploads` | 测试和第二个实例必须指向独立目录。启动 GC 只清理带本库 owner 戳、且在认领之后写入的孤儿文件 |
| `AGENT_BOARD_WEBHOOK_SECRET` | 空（webhook 关闭） | 设置后开启 `POST /api/hooks/tasks` |

模板见 [.env.example](./.env.example)。Compose 会读取同目录 `.env` 里的 `AGENT_BOARD_WEBHOOK_SECRET`（若有）。

### Docker 与 CLI（重要）

看板通过 **Node `spawn` 调用本机 CLI**（`pi` / `claude` / `agent` / `devin` / `codex`）。`app` 镜像**不包含**这些二进制，也不带你的登录态（API key / OAuth cookie）。

因此：

- **推荐**：`docker compose up -d postgres` + 本机 `pnpm dev` —— 完整建任务 / 跑 / 停 / 续跑。
- **仅 Compose 起 `app`**：适合看 UI、调 HTTP/SSE、用 webhook 建草稿；在容器里点「开跑」通常会因找不到 CLI 而失败。
- 若坚持在容器里 spawn：需自行挂载宿主机 home（工作区路径）、把 CLI 二进制挂进 `PATH`，并挂载各 CLI 的配置/凭证目录；不同工具路径不一，且权限/网络与宿主机差异大，本仓库不默认开启。

工作区目录浏览默认限制在**进程可见的 home** 下；纯容器部署若不挂载 `${HOME}`，侧栏路径选择器看不到宿主机项目。

## 本机启动（非 Docker）

不破坏原有流程；与 Compose 可并存（注意 Postgres 端口）。

```bash
cd ~/projects/agent-board
pnpm install   # 或 npm i / bun i

# 默认连本机 Postgres :5432 / 库 agent_board
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_board'
# 若库不存在：
#   PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -c 'CREATE DATABASE agent_board;'
# 或只用 Compose 的库（127.0.0.1:5433，密码见 .env）：
#   docker compose up -d postgres
#   export DATABASE_URL='postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/agent_board'

pnpm dev
# 或生产式：pnpm start   # 默认 PORT=8791
```

浏览器打开 http://127.0.0.1:8791

首次启动若存在 `data/db.json`，会自动迁移到 Postgres，并将 JSON 改名为 `db.json.migrated-*`。

## Android、中继、connector

本仓库同时包含 ThinkBook 看板、公网中继、本机 connector，以及 Android 客户端。看板 HTTP 仍只应绑在 `127.0.0.1`。手机只连中继。

| 目录 | 作用 |
| --- | --- |
| `android/` | Kotlin Compose APK，`tech.mengfei.agentboard`。本地 `./gradlew :protocol:test` 与 `assembleRelease`（未签名） |
| `relay/` | Node 中继（HTTP 配对 + WebSocket）。不调用看板、不 spawn CLI |
| `connector/` | ThinkBook 上的独立进程，把中继命令译成本机 `127.0.0.1:8791` |
| [PROTOCOL.md](./PROTOCOL.md) | 信封、配对、幂等与 `useGitWorktree` |

发布 APK：在 GitHub 上 **Publish a release**。`.github/workflows/release-apk.yml` 会用 JDK 17 和 Android SDK 35 跑 `./gradlew :app:assembleRelease`，并把未签名包 `agent-board-<tag>.apk` 挂到该 Release。不需要签名密钥。说明见 [android/README.md](./android/README.md)。

## 测试

```bash
pnpm install
pnpm test              # 单元 + 集成 + e2e
pnpm test:unit         # node:test 纯函数 / 解析（src/**/*.test.ts）
pnpm test:integration  # 真 API + embedded Postgres + fake runner（I1–I12）
pnpm test:coverage     # 单元 + c8（含 runners buildArgs / db；不含 server/store/manager）
pnpm test:coverage:full # 同上但 all=true，报告写入 coverage-full/（全仓诚实视图）
pnpm coverage          # test:coverage 别名
pnpm test:e2e          # puppeteer-core：空间设置 + E1–E4 + E5–E7 + E8–E9（mock API）
```

集成测试会临时拉起 `embedded-postgres`（不碰生产 `DATABASE_URL`），用 Hono `app.request` 打真实路由，runner 换成内存 fake（不 spawn 本机 CLI）。首次需允许原生依赖构建：`pnpm` 的 `onlyBuiltDependencies` 已包含 `@embedded-postgres/linux-x64`。

覆盖率报告（仅单元；集成/e2e 不并进同一报告）：

- 默认：`pnpm test:coverage` → `coverage/index.html`（已纳入各 runner 的 `buildArgs` 与 `db` 脱敏；仍排除难单测的 `server`/`store`/`manager`）
- 全仓：`pnpm test:coverage:full` → `coverage-full/`（`all: true`，含未跑到的 spawn 路径，便于看缺口；不设门槛）
- LCOV：`coverage/lcov.info`（可给 IDE / CI 用）

## 重新截图（可选）


服务需已在 `8791` 运行，本机有 Google Chrome：

```bash
pnpm exec node scripts/capture-screenshots.mjs
```

截图输出到 `docs/screenshots/`。

## 致谢 / 友情链接

- [LINUX DO](https://linux.do/) — 感谢社区氛围与开源推广支持
