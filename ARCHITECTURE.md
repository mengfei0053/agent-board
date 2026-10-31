# agent-board 架构（v0.1）

本机 Web 看板：新建 / 观察 / 停止本地 Agent CLI 任务。覆盖 **pi / Claude Code / Cursor CLI / Devin CLI / Codex CLI**。

## 目标

- 左侧工作区 CRUD；右侧显示当前工作区任务（选 kind、prompt、可选 model；cwd 来自工作区）
- 看到运行中任务的状态：`queued | running | blocked | succeeded | failed | stopped`
- 实时尾随日志（SSE）
- 停止任务（杀进程组）
- 任务迭代次数 +「继续任务」（基于各 CLI session/resume 续上下文）
- 卡片多选与批量删除（运行中先 stop 再删）

## 不做（v0.1）

- 不接管「已经在别的终端交互开着」的 TUI（那要 hooks/ACP 旁路；后续可接）
- 不接 Herdr 面板
- 不做多机调度 / 权限细粒度 / 费用账单

## 组件

```
浏览器 ──REST/SSE──▶ Hono 服务（本机）
                        │
                        ├─ TaskStore（Postgres · DATABASE_URL）
                        │     workspaces + tasks.workspace_id
                        ├─ Runner 注册表（命令名可被设置页覆盖，见 meta.cli_paths）
                        │    ├─ pi:    pi -p --mode json --session-id
                        │    ├─ claude: claude -p --output-format stream-json
                        │    ├─ cursor: agent -p --output-format stream-json
                        │    ├─ devin:  devin -p --permission-mode accept-edits (plain stdout)
                        │    └─ codex:  codex exec --json --approve-for-me
                        └─ 每任务：子进程 + data/logs/<id>.jsonl
```

## 状态机

`draft → queued → running → (blocked?) → succeeded|failed|stopped`

- 新建默认 **draft**（不 spawn）；拖到 Todo / `POST .../start|move` 才开始跑

- **pi**：`agent_start`/`tool_execution_start` → running；`ask_user_question` → blocked；`agent_settled` / 进程退出 → 终态
- **claude / cursor**：收到 stream-json 事件 → running；进程 exit 0 → succeeded，非 0 → failed；未知事件只记日志
- **devin**：`-p` 纯文本 stdout（无 stream-json）；exit 0 → succeeded（若日志含 `Error: Agent error` 则标 failed）；session 在结束后用 `devin list --format json` / sessions.db 尽力回填，继续任务用 `-r <sid>`（无 id 时新开跑 + 原 `task.prompt`，不用 `-c`）
- **codex**：`codex exec --json`（thread JSONL：`thread.started` / `turn.*` / `item.*`）→ running；exit 0 → succeeded；`thread_id` 写入 sessionId；继续任务用 `codex exec resume <id>`（无 id 时新开 `codex exec` + 原 `task.prompt`，不用 `--last`）；非交互审批用 `--approve-for-me`

## 后续扩展点

1. 用 Claude hooks / pi extension / Cursor ACP 上报「外部已开会话」到同一 Store
2. 接 Herdr socket（本机已有 `herdr-agent-state.ts`）做旁路状态
3. SQLite、多用户、按仓库过滤、重跑、模板任务

## 继续任务 / 迭代

- `Task.iteration`：创建为 1，每次 `POST /api/tasks/:id/continue` 成功后 +1
- `Task.sessionId`：各 runner 持久化会话 id，供续跑
- pi：`--session-id`（不再 `--no-session`）
- Claude：首跑 `--session-id <uuid>`，续跑 `--resume <id>`（无 id 时新开 `--session-id` + 原 `task.prompt`，不用 `--continue`）
- Cursor：首跑 `agent create-chat` + `--resume` + `--trust`，续跑 `--resume`（无 id 时新开 chat + 原 `task.prompt`，不用 `--continue`）
- Codex：首跑 `codex exec --json …`，从 `thread.started.thread_id` 记 session；续跑 `codex exec resume <thread_id> --json …`（无 id 时新开 `exec` + 原 `task.prompt`，不用 `--last`）

## 批量删除

- `POST /api/tasks/batch-delete` body `{ ids: string[] }`
- 对仍在跑 / 有 handle 的任务先 stop，再从 store 删除并清日志；SSE `task_delete`

## 删除限制

- `queued`（Todo）与 `running`（进行中）不可删除；批量删除会跳过并返回 `skipped`
- `draft` / `blocked` / 终态可删（blocked 删除时会先 stop）

## Webhook 新建任务

外部系统可通过 webhook 新建**草稿**或**Todo（创建并开跑）**。

- **Endpoint**：`POST /api/hooks/tasks`（别名 `POST /webhook/tasks`）
- **鉴权**（必填）：环境变量 `AGENT_BOARD_WEBHOOK_SECRET`
  - 未设置 → `503`（webhook 关闭）
  - 请求头二选一：
    - `Authorization: Bearer <secret>`
    - `X-Webhook-Secret: <secret>`
- **Body JSON**
  | 字段 | 必填 | 说明 |
  |---|---|---|
  | `prompt` | ✅ | 任务内容 |
  | `agent` | ✅ | `pi` | `claude` | `cursor` | `devin` | `codex`（也可用别名 `kind`） |
  | `cwd` | ✅ | 工作目录（须已存在） |
  | `model` | | 可选模型 |
  | `title` | | 可选标题 |
  | `start` | | `true` → 创建并开跑（Todo） |
  | `lane` / `mode` | | `draft`（默认）或 `todo`（同 `start: true`） |
- **响应**：`201 { task, started }`

启动前设置 secret：

```bash
export AGENT_BOARD_WEBHOOK_SECRET='replace-me'
pnpm start   # 或 npm start / PORT=8791 …
```

示例 — 新建草稿：

```bash
curl -sS -X POST http://127.0.0.1:8791/api/hooks/tasks \
  -H "Authorization: Bearer $AGENT_BOARD_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "整理 README",
    "agent": "pi",
    "cwd": "/home/menghongfei/projects/agent-board",
    "mode": "draft"
  }'
```

示例 — 新建 Todo 并立刻开跑：

```bash
curl -sS -X POST http://127.0.0.1:8791/webhook/tasks \
  -H "X-Webhook-Secret: $AGENT_BOARD_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "跑一遍 typecheck 并修错",
    "agent": "claude",
    "cwd": "/home/menghongfei/projects/agent-board",
    "start": true
  }'
```

## 后台 / Monitor / 子代理（sideJobs）

从 pi / Claude / Cursor 事件流解析并写入 `Task.sideJobs`：

- pi：`tool_execution_start|end`（`Agent` / `Task*` / `Monitor` / 带 `run_in_background` 的 `Bash`）
- Claude/Cursor stream-json：`assistant`/`user` 的 `tool_use` / `tool_result`；`system`+task/monitor subtype
- 详情「后台 / Monitor」；卡片角标「N 后台」；解析失败不影响主流程


## CLI 路径与进程代理设置

- UI：左上角 **agent-board** 菜单 → **设置**（`/settings`）
- API：`GET /api/settings` · `PUT /api/settings`
  - `cliPaths`: `{ "pi"|"claude"|"agent"|"devin"|"codex": "<path或空>" }`
  - `proxyEnv`: **按 Agent kind 分桶**  
    `{ "pi"|"claude"|"agent"|"devin"|"codex": { "HTTP_PROXY"|"HTTPS_PROXY"|"NO_PROXY"|"ALL_PROXY": "<值或空>" } }`  
    （可只传部分 kind / 键；空字符串清除该项）
  - `{ "clear": true }` 清除路径与代理全部覆盖
- 持久化：`meta.cli_paths` · `meta.proxy_env`（JSON，代理为 per-kind）
  - 兼容：若读到旧版全局扁平 `{ HTTP_PROXY: "..." }`，启动时复制到全部 kind 并写回新结构
- Runner：`resolveCliCommand(kind)` 取命令；`childProcessEnv(kind, extras)` 只注入**该 kind** 的代理覆盖到 `spawn` / `spawnSync`（日志只记键名，不记值）

## 存储（Postgres）

- 连接串：环境变量 `DATABASE_URL`（默认 `postgresql://postgres:postgres@127.0.0.1:5432/agent_board`）
- 表：`tasks`、`task_logs`、`task_outputs`、`task_side_jobs`、`meta`（含 `default_workspace_id`、`cli_paths`、`proxy_env` 等）
- 进程内有内存镜像；写入先更新内存再异步落库（API/SSE 行为不变）
- 旧 `data/db.json` + `data/logs/*.jsonl`：启动时一次性迁移，JSON 归档为 `db.json.migrated-*`
- 可选：`docker compose up -d` 起隔离库（宿主机 **5433**），见 `docker-compose.yml`

## 工作区 Git 状态

- `GET /api/workspaces/:id/git-status`（`?refresh=1` 跳过缓存）
- 只读：对工作区 `path` 下每个 `.git`（目录或文件）跑 `git status --porcelain=v1 -b -z` 与 `git log -1`
- 发现上限：深度 **6**（根为 0）、仓库 **32**、目录 **4000**、每仓库文件行 **200**；不进入 `node_modules` / `vendor` / `dist` / `build` / `target` / `.git` 内部 / `.agent-board` 等目录（避免把看板 worktree 扫成额外仓库）
- 结果内存缓存约 3 秒；扫描与 git 调用异步，不阻塞其它请求
- 路径只来自已保存的工作区，忽略客户端传入的 path；子进程去掉 `GIT_DIR` 等会把 git 指到别处的环境变量
- UI：看板当前工作区横幅下，以及 `/workspaces/:id/settings`

## 可选 git worktree

- 资格只认 **work tree 根** 且 **HEAD 可解析**（无提交的 unborn 仓库不合格）。嵌套在非 git 工作区里的仓库不合格。实现是 `getGitWorktreeEligibility`：先 `resolveAllowedDirectory`（realpath），所有 git 子进程去掉 `GIT_*`，读操作超时与 git status 相同。
- `GET /api/workspaces/:id/git-worktree-eligibility` 与创建时复验都走这个 helper。`git-status` 里 `relPath === "."` 不能代替它。
- `POST /api/tasks` 与 webhook 接受可选 `useGitWorktree`（布尔，默认关）。非布尔、不合格、unborn、目标路径或 `agent-board/<id>` 分支已存在 → **400**，不留下任务行，也不留下本次新建的 worktree。git 启动失败或其它文件系统错误 → **500**。
- 成功时 `task.cwd` 为 `<base>/.agent-board/worktrees/<taskId>`，并保存 `worktree: { path, branch, baseHead, owned: true }`。`baseHead` 只作记录，删除时不拿它当身份。
- 只在任务**删除**时清理。须 `owned`、realpath 落在预期路径、`git worktree list` 仍登记该路径与分支 `agent-board/<taskId>`。目录有未提交改动则 **不** `worktree remove --force`，保留目录并在删除结果里给出 `warnings`。干净则 `worktree remove`（不带 `--force`），再尽力 `git branch -D`。
- 持久化失败（行还没落上）会回滚刚加的 worktree。`createAndStart` 在草稿已经落库之后失败 **不** 回滚。
- 未匹配到工作区的自由 cwd 仍挂到默认工作区（与以前相同）；worktree 建在该 cwd 的 git 根下。看板新建表单始终传当前 `workspaceId`。
- 不修改用户的 `.gitignore`。建议忽略 `.agent-board/`。

## 任务内容图片

- 创建 / 续跑输入框支持粘贴截图或「插入图片」；上传到 `data/uploads/`，在 prompt 中写入 Markdown `![alt](/uploads/<id>.ext)`
- `POST /api/uploads`（multipart 字段 `file`，仅 PNG/JPEG/GIF/WebP，≤8MB）；`GET /uploads/:name` 静态读取
- 看板详情与卡片缩略图按 Markdown 渲染；派发 CLI 前会把 `/uploads/…` 展开为绝对路径，便于本机 Agent 读图
