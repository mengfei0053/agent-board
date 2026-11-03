---
sidebar_position: 2
title: 看板 HTTP / SSE API
description: 看板后端的任务、工作区、Git、设置、上传、Webhook 和 SSE 接口参考。
---

默认 Base URL：`http://127.0.0.1:8791`。本页的 `:id`、`:name` 均为需要替换并进行 URL 编码的路径参数。普通接口没有统一用户认证；仅 Webhook 单独校验密钥。请保持本机监听，不要直接暴露到公网。

## 通用约定

- JSON 请求使用 `Content-Type: application/json`，对象请求体不接受数组或 `null`。
- JSON 请求体上限为 **1 MiB**；multipart 请求上限为 **32 MiB + 512 KiB**。请求体超限返回 `413`。
- `prompt` / 续跑指令上限 100,000 字符，`title` / `model` 上限 200 字符；字段超限通常返回 `413`。
- 任务 cwd、工作区 path 必须是已存在的绝对目录；解析符号链接后须位于 home、系统临时目录或 `AGENT_BOARD_ALLOWED_ROOTS` 指定的根目录内。额外根目录使用系统路径分隔符分隔。
- 普通错误响应为 `{"error":"message"}`。常见状态：`400` 输入或操作不合法、`404` 资源不存在、`409` 归档只读冲突、`413` 超限、`500` 内部或持久化失败。关闭排空期间写请求返回 `503 {"error":"shutting down"}`。
- 归档任务执行 start / stop / continue 等只读保护操作时返回 `409 {"error":"…","code":"archived_readonly"}`；Web 的 move 是专门的恢复与泳道操作入口。

## 接口索引

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 健康与持久化状态 |
| GET | `/api/browse` | 浏览 home 内子目录 |
| GET / POST | `/api/workspaces` | 工作区列表 / 创建 |
| GET / PATCH / DELETE | `/api/workspaces/:id` | 工作区详情 / 更新 / 删除 |
| GET | `/api/workspaces/:id/git-status` | 工作区 Git 状态 |
| GET | `/api/workspaces/:id/git-worktree-eligibility` | worktree 创建资格 |
| GET / POST | `/api/tasks` | 任务列表 / 创建 |
| GET | `/api/tasks/:id` | 完整任务详情 |
| GET | `/api/tasks/:id/log` | 日志尾部 |
| POST | `/api/tasks/:id/start` | 启动任务 |
| POST | `/api/tasks/:id/stop` | 停止任务 |
| POST | `/api/tasks/:id/continue` | 继续任务 |
| POST | `/api/tasks/:id/move` | 移动泳道 |
| POST | `/api/tasks/:id/archive` | 仅归档已结束任务 |
| POST | `/api/tasks/batch-delete` | 批量删除 |
| POST | `/api/hooks/tasks`、`/webhook/tasks` | 带密钥创建任务 |
| GET | `/api/events` | SSE 实时快照与增量 |
| GET / PUT | `/api/settings` | 全局设置读取 / 更新 |
| POST | `/api/settings/pair-code` | 为当前看板生成 Relay 配对码 |
| GET | `/api/model-history` | 最近使用模型 |
| POST | `/api/model-history/import` | 导入旧模型历史 |
| POST | `/api/uploads` | 图片 / 普通附件上传 |
| GET | `/uploads/:name` | 文件读取或下载 |

## 数据模型

### Task

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id`、`title` | string | 任务标识、标题 |
| `kind` | string | `pi`、`claude`、`cursor`、`devin`、`codex` |
| `workspaceId`、`cwd`、`prompt` | string | 工作区、实际执行目录、初始指令 |
| `status` | string | `draft`、`queued`、`running`、`blocked`、`succeeded`、`failed`、`stopped`、`archived` |
| `iteration` | number | 创建时为 1，续跑递增 |
| `createdAt`、`updatedAt` | string | ISO 时间字符串 |
| `model`、`sessionId` | string，可选 | 模型与 CLI 会话 |
| `startedAt`、`endedAt` | string，可选 | ISO 执行时间 |
| `pid`、`exitCode` | number，可选 | 进程与退出码；`exitCode` 也可能为 `null` |
| `summary`、`output`、`error`、`lastEvent` | string，可选 | 摘要、最新回复、错误、最近事件 |
| `prompts` | array，可选 | 每轮 `{iteration,prompt,at?}` |
| `outputs` | array，可选 | 每轮 `{iteration,text,at?}` |
| `sideJobs` | array，可选 | `{id,kind,title,status,summary?,toolName?,startedAt?,endedAt?}`；后台条目来自 CLI 事件观察 |
| `attachments` | array，可选 | `{name,originalName,url,mime,size}` |
| `worktree` | object，可选 | `{path,branch,baseHead,owned:true}` |

列表、SSE `hello` 和 `task_upsert` 返回卡片摘要：附加 `boardSummary: true`，对 prompt/output 及轮次文本超过 2,000 字符的部分截断并追加省略号，设置 `promptTruncated` / `outputTruncated`。详情接口返回完整文本，不能用摘要覆盖已加载的详情。

### Workspace

```json
{
  "id": "workspace1",
  "name": "示例项目",
  "path": "/home/me/projects/demo",
  "createdAt": "2026-11-01T10:00:00.000Z",
  "updatedAt": "2026-11-01T10:00:00.000Z",
  "settings": {
    "systemPrompt": "先测试，再修改。",
    "skills": ["programming-standards"],
    "mcp": "{\"mcpServers\":{}}"
  }
}
```

`settings` 及其字段可省略。`systemPrompt` / `mcp` 各上限 100,000 字符，单个 skill 上限 2,000 字符。MCP 可为结构化 JSON 字符串或旧的纯文本说明。

## 健康检查与目录

### GET `/api/health`

正常 `200`：

```json
{"ok":true,"db":{"ok":true}}
```

持久化降级时返回 `503 {"ok":false,"db":{"ok":false,"error":"…"}}`。

### GET `/api/browse`

查询参数 `path` 可选，默认用户 home；支持 `~`，仅允许浏览解析后位于 home 内的目录。此限制比任务 cwd 的允许根目录更严格。不列出隐藏目录，仅返回直接子目录名称。

```json
{"path":"/home/me/projects","parent":"/home/me","entries":["demo","tools"]}
```

## 工作区与 Git

| 接口 | 请求 | 成功响应 |
| --- | --- | --- |
| GET `/api/workspaces` | 无 | `200 {workspaces: Workspace[], defaultWorkspaceId}` |
| POST `/api/workspaces` | `{name,path}`；name 必填且最多 200 字符，path 必填且最多 4,000 字符 | `201 {workspace}` |
| GET `/api/workspaces/:id` | 路径中的工作区 ID | `200 {workspace,defaultWorkspaceId}` |
| PATCH `/api/workspaces/:id` | `{name?,path?,settings?}` | `200 {workspace}` |
| DELETE `/api/workspaces/:id` | 无请求体 | `200 {deleted:[id]}` |

PATCH 省略 name/path 保留原值；空白 name/path 也保留原值。**出现 `settings` 时替换整个设置对象，不是逐字段合并**：省略的设置项会被清除；`settings: {}` 或 `null` 清空设置。`skills` 可传字符串数组或按行分隔的字符串。更新工作区不会修改已有任务的 `cwd`。默认工作区、仍有任务的工作区不能删除，返回 `400`；不存在返回 `404`。

```bash
curl -X PATCH http://127.0.0.1:8791/api/workspaces/WORKSPACE_ID \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"systemPrompt":"先测试，再修改。","skills":["programming-standards"],"mcp":""}}'
```

### GET `/api/workspaces/:id/git-status`

可选查询 `refresh=1` 或 `refresh=true` 跳过短期缓存。扫描根目录来自已保存的工作区，不能通过 query 传入任意仓库路径。

返回 `200 {workspaceId,root,repos,truncated,scannedDirs,caps,cached}`：

- `repos[]`：`path`、`relPath`、`branch`、`detached`、`upstream`、`ahead`、`behind`、`upstreamGone`、`dirty`、`head`、`subject`、`noCommits`、`files`、`fileCount`、`filesTruncated`、`error`。
- `files[]`：`{code,x,y,path,origPath?,label}`，`code` 为 Git porcelain XY 状态。
- `branch` / `upstream` / `head` / `subject` 可为 `null`；没有 upstream 时 `ahead` / `behind` 为 `null`。
- `caps` 提供 `maxDepth`、`maxRepos`、`maxDirs`、`maxFilesPerRepo`；`truncated` 或 `filesTruncated` 为真时不能视为完整扫描结果。单仓库错误通过 `repos[].error` 表示。

### GET `/api/workspaces/:id/git-worktree-eligibility`

符合条件返回 `200 {ok:true,root,head}`；不符合返回 `200 {ok:false,reason}`，例如目录不是 Git 工作树根目录或仓库尚无提交。工作区不存在为 `404`，探测内部失败可为 `500`。资格探测不能代替创建时校验。

## 任务读取与创建

### GET `/api/tasks`

可选查询 `workspaceId` 过滤，返回 `200 {tasks: Task[], workspaceId: string|null}`。返回所有匹配状态（含归档）的摘要，不分页；没有过滤时 `workspaceId` 为 `null`。

### GET `/api/tasks/:id`

返回 `200 {task,log:[],logLineCount}`；`task` 是完整详情。原始日志不嵌入详情，需使用日志接口。不存在返回 `404`。

### GET `/api/tasks/:id/log`

可选查询 `lines` 默认 500；有限数值截断取整后限制到 50–2,000，非法数值回退为 500。返回 `200 {log: string[],logLineCount}`。`logLineCount` 是服务当前保留的日志行数，可能大于此次返回的尾部行数。

### POST `/api/tasks`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | 五种 Agent 之一，区分大小写 |
| `prompt` | 是 | 非空指令，最多 100,000 字符 |
| `workspaceId` / `cwd` | 二选一 | 优先 workspaceId，cwd 为回退目录；不是 Relay 主机上的目录 |
| `title` | 否 | 最多 200 字符，省略时自动生成 |
| `model` | 否 | 最多 200 字符，省略使用 CLI 默认 |
| `start` | 否 | `true` 创建并启动；省略、`false` 或 `null` 仅保存草稿；不接受字符串布尔值 |
| `useGitWorktree` | 否 | 严格 boolean；省略/false 不隔离，true 创建 worktree；`null` 不合法 |
| `attachments` | 否 | 最多 20 个已上传附件引用，格式 `{name,originalName?,mime?,size?}`；使用上传返回值 |

```bash
curl -X POST http://127.0.0.1:8791/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"kind":"pi","workspaceId":"WORKSPACE_ID","prompt":"检查测试失败的原因","start":true,"useGitWorktree":false}'
```

成功 `201 {task}`。选择 worktree 时在原工作区的 `.agent-board/worktrees/<taskId>` 创建目录与 `agent-board/<taskId>` 分支，任务 `cwd` 指向该目录。创建或启动失败不保证回滚已保存的草稿，重试前请检查任务列表，普通 HTTP 创建不提供幂等键。

## 任务操作

除 continue / move / batch-delete 外，以下 POST 不需要请求体。单任务操作不存在通常返回 `404`。

| 接口 | 请求体 | 成功响应与语义 |
| --- | --- | --- |
| POST `/api/tasks/:id/start` | 无 | `200 {task}`，启动任务；归档任务只读 |
| POST `/api/tasks/:id/stop` | 无 | `200 {task}`，停止进程并写入 stopped 状态；归档任务只读 |
| POST `/api/tasks/:id/continue` | 可省略或 `{prompt?}` | `200 {task}`，新增一轮并优先复用任务 session；省略/空白指令使用默认继续指令 |
| POST `/api/tasks/:id/move` | `{lane}` | `200 {task}`；lane 为 `draft` / `todo` / `running` / `done` / `archived` |
| POST `/api/tasks/:id/archive` | 无 | `200 {archived:true,taskId}`，仅允许 succeeded / failed / stopped；草稿或活跃任务 `400`，已归档 `409` |
| POST `/api/tasks/batch-delete` | `{ids:string[]}` | `200 {deleted,stopped,skipped,warnings}`；非空，最多 200 个 ID |

move 会执行操作而不仅是改标签：移至 todo/running 会启动非活跃任务；draft 会停进程并保存草稿；done 会停止活跃任务，或从归档恢复之前的终态；archived 可停止活跃任务并归档。它与仅接受终态的 archive 接口不同。

批量删除跳过 queued/running，不存在的 ID 忽略，重复 ID 去重。`skipped[]` 是 `{id,status,reason}`；若没有删除任何任务且存在跳过项，返回 `400` 并附相同结果字段与 error。`stopped` 记录删除前停止的任务。`warnings[]` 为 `{taskId,code,message}`，例如 `worktree_cleanup_skipped_dirty`：任务已删除，但有未提交修改的 worktree 被保留；应显示警告而不是宣称文件也已删除。

## Webhook 创建任务

`POST /api/hooks/tasks`，兼容别名 `POST /webhook/tasks`。

先在看板进程配置 `AGENT_BOARD_WEBHOOK_SECRET` 并重启，再使用以下任一请求头：

```text
Authorization: Bearer YOUR_WEBHOOK_SECRET
X-Webhook-Secret: YOUR_WEBHOOK_SECRET
```

同时提供时 Bearer 优先。未启用返回 `503`（含 error/hint），密钥错误返回 `401`。

请求字段：必填 `prompt`、`agent`（兼容 `kind`，转为小写）；`workspaceId` / `cwd` 二选一；可选 `title`、`model`、`useGitWorktree`。显式 boolean `start` 优先，否则通过 `lane`（兼容 `mode`）决定：`todo` 启动，`draft` 或省略仅保存。Webhook 当前不读取 `attachments`。

```bash
curl -X POST http://127.0.0.1:8791/api/hooks/tasks \
  -H "Authorization: Bearer $AGENT_BOARD_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"agent":"codex","cwd":"/home/me/projects/demo","prompt":"修复 CI 失败","lane":"draft"}'
```

成功 `201 {task,started:boolean}`。请求成功只表示任务创建/启动流程返回，不代表执行完成。

## SSE 实时事件

### GET `/api/events`

返回 `text/event-stream`。使用 `EventSource` 或 `curl -N`：

```bash
curl -N http://127.0.0.1:8791/api/events
```

```text
event: hello
data: {"type":"hello","tasks":[],"workspaces":[]}

event: task_delete
data: {"type":"task_delete","taskIds":["task1"]}
```

| SSE event | data JSON |
| --- | --- |
| `hello` | `{type:"hello",tasks,workspaces}`，连接建立时的完整当前快照 |
| `task_upsert` | `{type:"task_upsert",task}`，卡片摘要 |
| `task_delete` | `{type:"task_delete",taskIds:string[]}` |
| `task_log` | `{type:"task_log",taskId,line,at}`，at 为 ISO 字符串 |
| `workspace_upsert` | `{type:"workspace_upsert",workspace}` |
| `workspace_delete` | `{type:"workspace_delete",workspaceIds:string[]}` |
| `ping` | `{}`，每 15 秒保活 |

事件面向全看板，没有 workspace 查询过滤。每连接发送队列最多 100 条，慢客户端会断开。重新连接收到新 hello；不支持持久化游标或 `Last-Event-ID` 补播。HTTP 响应与 SSE 事件没有先后顺序保证。

## 全局设置

### GET `/api/settings`

直接返回设置文档，不包在 `settings` 中：

| 字段 | 结构 |
| --- | --- |
| `cliPaths` | 按 Agent kind 索引，每项 `{default,override,effective,resolved,label}`，resolved 可能为 null |
| `proxyEnv` | 按 Agent kind、环境变量键索引，每项 `{override,effective,inherited,configured,hasCredential}` |
| `processEnv` | 按 Agent kind 索引的自定义环境变量，每项是 `{变量名:值}`；无配置时为空对象 |
| `quickPrompts` | `[{id,label,content}]` |
| `codexSandbox` | boolean |

代理键支持 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`ALL_PROXY`。URL 用户信息以 `***` 脱敏，仍不应记录整份设置文档。

`processEnv` 的变量名须匹配 `[A-Za-z_][A-Za-z0-9_]*`（最长 128 字符），值最长 8192 字符，每个 kind 最多 50 项。代理键和控制面密钥（如 `DATABASE_URL`、`AGENT_BOARD_WEBHOOK_SECRET`）不能通过此项设置。

### PUT `/api/settings`

请求至少包含一组设置；未提交的组/键保持不变。读取返回的字段描述对象不能直接用作写入值。

```json
{
  "cliPaths": {"pi": "/home/me/.local/bin/pi"},
  "proxyEnv": {"codex": {"HTTPS_PROXY": "http://127.0.0.1:7890"}},
  "processEnv": {"pi": {"OPENAI_BASE_URL": "https://example.test/v1"}},
  "quickPrompts": [{"label": "继续", "content": "继续并运行测试"}],
  "codexSandbox": true
}
```

- `cliPaths` 的值为字符串，空字符串或 null 清除该覆盖。
- `proxyEnv` 按 Agent / 变量逐项更新，空字符串或 null 清除覆盖，之后可能重新继承进程环境；脱敏占位值保留原凭据。
- `processEnv` 按 Agent kind 整体替换：提交的该 kind 对象即完整集合，空对象清空，省略 kind 保持不变；空字符串或 null 值的项被删除。
- `quickPrompts` 整体替换，`[]` 清空；最多保留 50 条，label 截至 40 字符，content 上限 100,000 字符；id 可省略，空白无效项被丢弃。
- `{clear:true}` 重置 CLI 路径、代理覆盖、自定义环境变量及 Codex sandbox（true），**保留快捷提示词**，该请求中的其他设置不再应用。

成功 `200` 返回提交后的脱敏设置文档。此接口不修改 Relay 的环境变量配置。

### POST `/api/settings/pair-code`

请求 `{adminToken:string}`，要求本机已启用并正确配置 Relay。向当前 Relay 的 `/auth/pair/create` 请求，仅授权当前 `boardId`；成功返回 `200 {pairCode,expiresAt,boardId}`，expiresAt 是 Unix 毫秒时间戳。响应带 `Cache-Control: no-store`。

管理员令牌只在当前请求使用，不保存到设置。Relay 未启用、令牌无效、限流或网络失败等以本机 `400 {error:"…"}` 返回，不直接透传上游状态码。

## 模型历史

| 接口 | 请求 | 成功响应 |
| --- | --- | --- |
| GET `/api/model-history` | 无 | `200 {history}` |
| POST `/api/model-history/import` | `{history:{pi?:string[],claude?:string[],cursor?:string[],devin?:string[],codex?:string[]}}` | `200 {history}` |

history 按 kind 返回最近使用的模型，每种最多 20 条，返回包含五种 kind 的数组。导入时每种也最多 20 条，单个模型去空白后非空且不超过 200 字符；已有数据库记录不覆盖使用时间，不支持通过此接口删除历史。

## 上传与下载

### POST `/api/uploads`

`multipart/form-data` 的 `file` 字段上传单个文件（兼容 `attachment` / `image` 文件字段）。

| 模式 | 选择方法 | 限制 | 成功响应 |
| --- | --- | --- | --- |
| 图片 | 默认 | PNG / JPEG / GIF / WebP，最大 8 MiB；校验内容与 MIME 一致 | `201 {name,url,mime,size}` |
| 通用附件 | query `as=attachment`；或表单 `as=attachment` / `attachment=true` / `attachment=1` | 非空，最大 32 MiB | `201 {name,originalName,url,mime,size}` |

```bash
curl -X POST 'http://127.0.0.1:8791/api/uploads?as=attachment' \
  -F 'file=@./report.pdf'
```

将附件返回值放入创建任务的 `attachments`；图片的 `url` 也可用于 prompt 的 Markdown 图片引用。文件大小不合法通常返回 `400`，请求体整体超限返回 `413`。

### GET `/uploads/:name`

使用上传返回的存储 name，不接受任意文件路径。可选 query：`download=1` / `true` 强制下载，`filename` 指定下载名。不存在或不安全名称返回 `404`。

经过内容识别且名称符合图片规则的文件可内联显示；其他文件始终使用 `application/octet-stream` 和附件下载，不能通过参数强制内联。上传资源不是独立鉴权的私密分享链接，同样应仅在可信本机边界访问。
