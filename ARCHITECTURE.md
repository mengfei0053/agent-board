# agent-board 架构（v0.1）

本机 Web 看板：新建 / 观察 / 停止本地 Agent CLI 任务。第一版覆盖 **pi / Claude Code / Cursor CLI**。

## 目标

- 在浏览器里创建任务（选 kind、cwd、prompt、可选 model）
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
                        ├─ TaskStore（data/db.json）
                        ├─ Runner 注册表
                        │    ├─ pi:    pi -p --mode json --no-session
                        │    ├─ claude: claude -p --output-format stream-json
                        │    └─ cursor: agent -p --output-format stream-json
                        └─ 每任务：子进程 + data/logs/<id>.jsonl
```

## 状态机

`queued → running → (blocked?) → succeeded|failed|stopped`

- **pi**：`agent_start`/`tool_execution_start` → running；`ask_user_question` → blocked；`agent_settled` / 进程退出 → 终态
- **claude / cursor**：收到 stream-json 事件 → running；进程 exit 0 → succeeded，非 0 → failed；未知事件只记日志

## 后续扩展点

1. 用 Claude hooks / pi extension / Cursor ACP 上报「外部已开会话」到同一 Store
2. 接 Herdr socket（本机已有 `herdr-agent-state.ts`）做旁路状态
3. SQLite、多用户、按仓库过滤、重跑、模板任务

## 继续任务 / 迭代

- `Task.iteration`：创建为 1，每次 `POST /api/tasks/:id/continue` 成功后 +1
- `Task.sessionId`：各 runner 持久化会话 id，供续跑
- pi：`--session-id`（不再 `--no-session`）
- Claude：首跑 `--session-id <uuid>`，续跑 `--resume <id>`（无 id 时回退 `-c`）
- Cursor：首跑 `agent create-chat` + `--resume` + `--trust`，续跑 `--resume`（无 id 时回退 `--continue`）

## 批量删除

- `POST /api/tasks/batch-delete` body `{ ids: string[] }`
- 对仍在跑 / 有 handle 的任务先 stop，再从 store 删除并清日志；SSE `task_delete`

