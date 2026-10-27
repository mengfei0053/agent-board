# agent-board 架构（v0.1）

本机 Web 看板：新建 / 观察 / 停止本地 Agent CLI 任务。第一版覆盖 **pi / Claude Code / Cursor CLI**。

## 目标

- 在浏览器里创建任务（选 kind、cwd、prompt、可选 model）
- 看到运行中任务的状态：`queued | running | blocked | succeeded | failed | stopped`
- 实时尾随日志（SSE）
- 停止任务（杀进程组）

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
