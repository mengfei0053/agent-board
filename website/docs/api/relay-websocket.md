---
sidebar_position: 4
title: Relay WebSocket API
description: Relay v1 WebSocket 信封、认证、任务与设置命令、事件、幂等和断线恢复。
---

连接地址：`ws://127.0.0.1:8787/v1/ws`；公网使用 `wss://<relay-host>/v1/ws`。手机只连接 Relay，本机看板主动拨出连接 Relay，Relay 不主动连接本机。

设备凭证通过 [Relay HTTP API](./relay-http.md) 配对获得。本页覆盖当前 v1 消息类型；更完整的线协议示例见仓库 [PROTOCOL.md](https://github.com/mengfei0053/agent-board/blob/HEAD/PROTOCOL.md)。

## 传输与信封

每条消息是一个 JSON 对象，仅接受文本帧，单帧最大 **256 KiB**。默认每连接每秒最多 40 条消息（`WS_MESSAGES_PER_SEC`），超限返回 `err/rate_limited`。默认最多 200 个连接，超出后以 WebSocket `1013 overloaded` 关闭。服务每 30 秒发送 WebSocket ping 控制帧，不是业务 JSON 消息。

```json
{
  "v": 1,
  "id": "phone-request-1",
  "type": "board.list",
  "ts": 1793527200000,
  "payload": {}
}
```

| 字段 | 要求 |
| --- | --- |
| `v` | 固定为 1 |
| `id` | 请求标识，1–100 个可见 ASCII 字符，建议每次请求生成唯一值 |
| `type` | 下文列出的消息类型 |
| `ts` | 有限数值，按协议使用 Unix 毫秒 |
| `payload` | 对象；board.list 可省略，其余按各类型要求 |

未知字段会被忽略且不转发，不能用未声明字段扩展命令。令牌放在首帧 payload，不放 URL。响应 `ack` / `err` 的 `payload.ref` 对应原请求 id；无法解析或没有有效请求 ID 的错误可能没有 ref。

标识约束：boardId / taskId 满足 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`；workspaceId 首字符额外允许 `_` / `-`。幂等键为 8–80 个可见 ASCII 字符。

## 首帧认证

### 手机：`client.hello`

```json
{
  "v": 1,
  "id": "hello-1",
  "type": "client.hello",
  "ts": 1793527200000,
  "payload": {"token":"dt_EXAMPLE","name":"Pixel 8"}
}
```

必填 token，可选 name（1–80 字符）。成功 ack payload 为 `{ref,stage:"executed",deviceId,role:"phone",boardIds}`。可访问范围来自设备令牌，不由请求中的 boardId 自行扩大。

### 看板：`board.register`

```json
{
  "v": 1,
  "id": "register-1",
  "type": "board.register",
  "ts": 1793527200000,
  "payload": {
    "boardId": "thinkbook-main",
    "token": "YOUR_BOARD_TOKEN",
    "label": "ThinkBook",
    "capabilities": ["archive.list","archive.write","workspace.settings","board.settings"]
  }
}
```

必填 boardId/token；label 可选（1–80 字符），capabilities 可省略。成功 ack payload 为 `{ref,stage:"executed",boardId,generation}`。新注册连接获得新的 generation，同一 socket 对相同 boardId 再次注册不会递增代次；相同 boardId 的新连接会替换并关闭旧连接。

只有上述两类消息可用作首帧；其他类型返回 unauthorized 提示。认证后一个 socket 固定为手机或看板角色。

## 看板发现与订阅

| 类型 | 手机发送的 payload | 响应与用途 |
| --- | --- | --- |
| `board.list` | `{}` 或省略 | ack `{ref,stage:"executed",boards}`，仅返回授权 ID |
| `sub.tasks` | `{boardId,afterSeq?}` | ack 带 boardId/generation，可能含 snapshotVersion；随后重放快照与任务增量，再推实时事件 |
| `sub.logs` | `{boardId,taskId?}` | ack 带 boardId 和可选 taskId；重放有界日志缓存并订阅新日志 |

boards 每项至少 `{boardId,online}`；已有运行记录时还可能含 generation，在线时含 capabilities / connectedAt，可选 label。先检查在线看板的 capabilities，再调用受能力门控的命令。

`afterSeq` 为非负安全整数，只用于跳过已处理的任务增量，不是跨代次的持久化游标。sub.logs 省略 taskId 表示该看板全部日志；同一看板再次调用会替换该 socket 的日志筛选。当前没有独立 unsubscribe 消息。

## 命令公共规则

除 `cmd.lookup` 外，下列命令会转发给本机看板。**包括只读 detail/get/list 在内**，payload 都要求：

```json
{"boardId":"thinkbook-main","idempotencyKey":"request-key-0001"}
```

命令通常经历两个 ack：

```json
{
  "v":1,"id":"relay-accepted-1","type":"ack","ts":1793527200010,
  "payload":{
    "ref":"phone-create-1","stage":"accepted","boardId":"thinkbook-main",
    "idempotencyKey":"request-key-0001","commandId":"cmd-example-1"
  }
}
```

最终 ack 使用相同 ref/key/commandId，`stage:"executed"`，并附命令对应结果。失败可能是 err，而 lookup 将记录状态作为 ack 返回。

| stage | 含义 | 客户端处理 |
| --- | --- | --- |
| `accepted` | Relay 已记录并转发，本机尚未答复 | 等待结果 |
| `executed` | 本机已接受或完成此项操作 | 对执行类任务继续观察事件，不等于任务完成 |
| `failed` | 已记录命令执行被拒绝或失败 | 显示错误，必要时 lookup |
| `timeout` | 默认 8 秒内未收到本机答复（CMD_TIMEOUT_MS） | 使用原键 lookup，不自动创建新命令 |
| `unknown` | lookup 查不到记录 | 结果不确定，不证明本机没执行 |

### 幂等与查询

键按 **boardId + 命令类型 + idempotencyKey** 区分，在有效期内重复提交返回已记录状态，不会因新 body 不同而重新执行。默认结果保留 10 分钟（`IDEMPOTENCY_TTL_MS`）；缓存只在内存，过期/重启后不提供恰好一次保证。

```json
{
  "v":1,"id":"lookup-1","type":"cmd.lookup","ts":1793527210000,
  "payload":{"boardId":"thinkbook-main","idempotencyKey":"request-key-0001","cmd":"cmd.create"}
}
```

lookup 的 cmd 必须是本页列出的转发命令类型，不能是 cmd.lookup 自身。它查询原键，不创建任务；命中返回记录的 stage、commandId 和结果或错误，未命中 stage 为 unknown。

`board_offline`、`forbidden`、`unauthorized`、`unsupported`、`bad_request`、`rate_limited` 等在记录前的拒绝不消耗键。看板离线时不会排队。已 accepted 后发生超时、断线或失败，应先 lookup；不要把更换键当成无风险重试。重新打开只读详情、刷新设置或翻页，应生成新键以获得新数据。

## 任务命令

下表“附加字段”均位于 payload，另需公共 boardId/idempotencyKey。

| 类型 | 附加字段 | executed 结果 |
| --- | --- | --- |
| `cmd.create` | 必填 title（1–200）、prompt（1–20,000）；可选 agent、cwd、workspaceId、useGitWorktree | `task` |
| `cmd.continue` | 必填 taskId；可选 prompt（最多 20,000，允许换行） | `task` |
| `cmd.stop` | 必填 taskId；可选 reason（1–500） | `task` |
| `cmd.detail` | 必填 taskId | `task`，完整详情，含 `detail:"full"` |
| `cmd.archive.list` | 可选 limit（1–50，默认20）、cursor、workspaceId | `archive:{tasks,nextCursor?,restarted?}` |
| `cmd.archive` | 必填 taskId | `{archived:true,taskId}`，没有 task 字段 |

### 创建与继续

```json
{
  "v":1,"id":"phone-create-1","type":"cmd.create","ts":1793527200000,
  "payload":{
    "boardId":"thinkbook-main","idempotencyKey":"request-key-0001",
    "title":"修复登录测试","prompt":"检查并修复登录测试失败",
    "agent":"pi","cwd":"/home/me/projects/demo","workspaceId":"workspace1","useGitWorktree":false
  }
}
```

- Relay 线协议允许省略 agent/cwd，但当前看板的嵌入连接器仍要求显式传入：agent 必须为 pi / claude / cursor / devin / codex，缺失或未知返回 unknown_agent；cwd 缺失返回 cwd_required。不要假定连接器会补默认值。
- cwd 是**看板主机**上的绝对目录（最多 1,024 字符），不是 Relay 的路径。即使传了 workspaceId，当前嵌入连接器也要求 cwd；实际执行时 workspaceId 对应的目录优先。
- useGitWorktree 是严格 boolean；仅 true 向看板转发隔离请求，false/省略使用原目录。Relay 本身不操作 Git。
- cmd.create 创建并启动任务，不支持本机 HTTP 的 start、model、attachments 等未声明字段；unknown 字段不会转发。
- cmd.continue 未传有效追加指令时使用默认继续指令。归档任务只读；要恢复归档任务请使用本机 Web 的 move 接口。

### 归档与能力门控

| 命令 | 必须由看板声明的 capability |
| --- | --- |
| `cmd.archive.list` | `archive.list` |
| `cmd.archive` | `archive.write` |
| `cmd.workspace.get` / `cmd.workspace.update` | `workspace.settings` |
| `cmd.settings.get` / `cmd.settings.put` | `board.settings` |

缺少能力返回 unsupported，不记录命令。归档列表与详情可返回 archived 状态，但活动快照和 evt.task 不接受该状态。

archive.list 的 cursor 来自上一次响应，格式为 `updatedAt:id` 或 `updatedAt:id:revision`；客户端应当作不透明字符串使用。workspaceId 在分页前过滤；省略或空值表示整个看板。集合变化或游标与工作区不匹配时可返回 `restarted:true`，应替换列表而不是追加。归档不在活动快照中。

cmd.archive 只接受 succeeded / failed / stopped。draft / queued / running / paused 不能归档；已归档返回 archived_readonly。归档后活动快照删除卡片，不产生完成通知。此语义比 Web 的 move 到 archived 更严格，不会停止正在执行的任务来归档。

## 工作区命令

| 类型 | 附加字段 | executed 结果 |
| --- | --- | --- |
| `cmd.workspace.create` | 必填 name（1–200）、path（绝对本机路径，最多1,024） | `workspace` |
| `cmd.workspace.delete` | 必填 workspaceId | `deleted`（被删除的工作区 ID 字符串） |
| `cmd.workspace.get` | 必填 workspaceId | `workspace` 详情 |
| `cmd.workspace.update` | 必填 workspaceId、name、path、settings | `workspace` 详情 |

create/delete 不要求 workspace.settings capability；get/update 要求。默认工作区、仍有任务的工作区不能删除。

update 的 settings 必须包含三项，空值表示清除：

```json
{
  "systemPrompt": "先运行测试",
  "skills": ["programming-standards"],
  "mcp": ""
}
```

与本机 PATCH 不同，远程 update **要求 name、path 及全部三项 settings**。systemPrompt/mcp 最多 100,000 字符；skills 为字符串数组或按行字符串，最多200项、每项最多2,000字符。设置整体替换，已有任务 cwd 不随更新改变。

get/update 的 workspace 为 `{id,name,path,isGit,settings,git}`。settings 总是包含 systemPrompt、skills、mcp，未设置时为空。git 为 `{branch,dirty,ahead,behind,detached,repoCount,error}`；ahead/behind 可为 null。Git 探测失败仍可返回名称、路径和设置，通过 git.error 报告，不等于设置保存失败。

## 全局设置命令

| 类型 | 附加字段 | executed 结果 |
| --- | --- | --- |
| `cmd.settings.get` | 无 | `settings` |
| `cmd.settings.put` | 至少一组 cliPaths、proxyEnv、quickPrompts、codexSandbox | 提交后的 `settings` |

读写形状见 [看板设置 API](./board.md#全局设置)。远程 put 只支持部分更新，**拒绝 `clear:true`**，不会清空设置，也不记录此拒绝。quickPrompts 是整体替换，其余省略的组/键保留。

代理请求可能包含新密码：Relay 转发但不把请求体保存在幂等记录中；返回和缓存的 settings 对 URL 用户信息脱敏为 `***`。提交脱敏占位值时保留已有秘密。不要在客户端日志中记录完整设置。

## 事件与任务模型

### 公共游标

看板上行的 evt.snapshot / evt.task / evt.log / evt.task.done 均包含：

```json
{"boardId":"thinkbook-main","generation":1,"seq":12,"eventId":"event-0012"}
```

generation 来自注册 ack，每个代次内 seq 递增，eventId 用于去重。客户端合并时必须同时考虑 boardId、generation、seq 和 eventId，不能只按到达顺序覆盖状态。

| 类型 | 方向 | 公共游标之外的 payload |
| --- | --- | --- |
| `evt.snapshot` | 看板 → 任务订阅者 | `version`（等于 seq）、`capturedAt`、`tasks`（最多200）、可选 workspaces |
| `evt.task` | 看板 → 任务订阅者 | `task`，任务更新 |
| `evt.log` | 看板 → 日志订阅者 | `taskId`、`stream`（stdout/stderr/system）、`line`（1–8,000） |
| `evt.task.done` | 看板 → 该看板授权的在线手机 | `taskId`、`status`（succeeded/failed/stopped）、可选 title/summary |
| `evt.gap` | Relay → 任务订阅者 | `boardId,generation,expectedSeq,gotSeq,reason`；不是普通增量，不携带上述完整公共游标 |

快照 workspaces 每项包含 id/name/path，可附 isGit（能否启用 worktree）。工作区变更也通过快照同步，没有独立的 workspace 事件类型。

### Relay Task

最小任务 `{id,title,status,updatedAt}`；updatedAt 是 Unix 毫秒。可选字段包括：

- `agent`、`workspaceId`、`iteration`、`cwd`、`model`、`sessionId`；
- `startedAt`、`endedAt`、`exitCode`、`pid`、`error`；
- `prompt`、`output`、`promptPreview`、`outputPreview`、`promptTruncated`、`outputTruncated`；
- `resumeCommand`、`worktreeBranch`、`detail:"full"`；
- `turns:[{iteration,prompt?,output?,at?}]`、`sideJobs:[{id,kind,title,status,summary?,toolName?}]`。

活动状态为 queued/running/paused/succeeded/failed/stopped。本机 draft 映射为 queued、blocked 映射为 paused，kind 映射为 agent。archived 仅在 detail/archive.list 的结果中使用。快照使用预览，详情与部分任务事件可包含完整内容；读取详情应调用 cmd.detail，而不是把预览当原文。

## 缺口与断线恢复

1. 手机连接并 client.hello 后，发送 board.list，再为需要的看板发送 sub.tasks；原始日志按需另行 sub.logs。
2. sub.tasks 重放缓存快照及其后的任务增量；sub.logs 重放有界日志。evt.task.done **不重放**，不能用它实现离线推送。
3. evt.gap 的 reason 为 `seq_gap` / `buffer_gap` / `generation_changed` / `ahead` / `no_snapshot` 时，标记列表过期并重新订阅。收到旧快照、日志或单个任务更新不足以清除缺口；要等待可覆盖缺口的恢复快照或新代快照。
4. 本机重连获得新 generation，seq 从头开始；不要将新旧代次增量混合。手机断线重连也须重新认证与订阅，并对未确认命令执行 lookup。
5. 凭证轮换、撤销或过期后旧连接不能继续接收事件；设备断线不会停止本机任务。

Relay 的认证、命令记录与快照缓存都不跨进程重启保留。无法确认结果时向用户显示“不确定”，不要盲目重新创建。实时完成通知按 eventId 去重，仅对在线有效会话尽力投递。

## 错误消息

```json
{
  "v":1,"id":"relay-error-1","type":"err","ts":1793527200010,
  "payload":{"ref":"phone-create-1","code":"board_offline","message":"board thinkbook-main is not connected","stage":"failed","idempotencyKey":"request-key-0001"}
}
```

常见 code：`bad_request`、`bad_version`、`bad_type`、`unauthorized`、`forbidden`、`board_offline`、`unsupported`、`rate_limited`、`timeout`、`archived_readonly`、`not_found`、`unknown_agent`、`cwd_required`。连接被替换可收到 `replaced`，看板被撤销可收到 `revoked`。错误的 stage 不单独证明键已记录，应结合是否收到 accepted 与 lookup 结果判断。
