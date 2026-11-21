# Grok Bot：运行一个已部署的 Cursor Agent SDK agent

此 runner 的目标是一个固定的 **Cursor 托管 v2 部署**，不是桌面 Grok Bot、xAI Chat API 或本机写代码的 CLI。它向部署发送任务文本，在 Board 保存最终回答；文件、工作区 MCP、模型与 reasoning effort 覆盖均不支持。模型、工具、代码仓库和权限由部署决定。Manager 只传本轮的 `task.prompt` 或 `continuePrompt`，不添加本地工作区指令或 skills 前缀，也不转发工作区 MCP。不要在任务提示中放秘密。

## 操作者准备

1. 准备专用服务账号/系统用户，把 agent 预先部署至受信任的 Cursor 团队，确认其 slug、权限与成本上限。Board 不负责创建或部署 Bot。CLI 未指定 `--team` 时使用凭据的默认团队；**不要跨团队复用/切换运行 Board 的身份**。同名 slug 在不同团队并不代表同一个 bot。
2. 使用 Node ≥22.13，在看板项目目录执行 `pnpm install`，会随服务端依赖安装 `@grok/agent-sdk@0.7.2`，无需全局安装。本机运行时打开 `http://127.0.0.1:8791/settings` →「Agent 运行环境」→ Grok Bot。点击「登录 Cursor」，打开官方授权链接并在浏览器确认。这个操作登录的是**看板服务账号**，不是为当前网页建立个人会话。返回设置页，读取已部署 Bot 列表、选择目标 slug，再勾选启用并保存；登录本身不会启用 Bot，也不会发起任务。已登录的服务器可以直接读取部署列表。若 Web 授权不可用，可用看板运行身份执行 `pnpm exec bdk login`；Docker 请在看板容器内执行。或者仅在服务端注入 Cursor 凭据（`CURSOR_API_KEY`、`CURSOR_API_KEY_FILE` 或 `CURSOR_SERVICE_ACCOUNT_KEY`）。**不要**把密钥填入 Board 设置、任务、CLI 路径或 URL。
3. 在 Board 设置启用 Grok Bot 并填入该部署 slug。Board 默认用自己的 Node 运行随项目安装的 CLI，不从任务工作区或 PATH 查找 `bdk`，也不会运行 `npx`。只有需要覆盖时才设置 `AGENT_BOARD_BDK_BIN=/absolute/path/to/bdk`，覆盖的 CLI 也必须是同一版本。子进程不继承自定义 API 地址、`NODE_OPTIONS`、Board 数据库或 webhook 凭据。只使用非交互 CLI。保持自己的 PATH、可执行文件、认证目录及其父目录不可被工作区用户修改。

Web 登录和读取部署列表只支持通过本机回环地址直接访问（也可用受信任的 SSH 本地端口转发）；局域网直连、Android 和带转发头的反向代理不会获得这些权限。对外提供看板的反向代理应显式禁止访问 `/api/settings/grok/*`，尤其不要把外部请求伪装为无转发头的本机请求。凭据由 SDK 存储在服务器用户目录，不通过网页表单、看板设置或中继传递。若浏览器授权产生的密钥不再需要，请在 Cursor 管理界面撤销；取消勾选 Grok Bot 只会禁用任务入口，不会撤销密钥。

## 一轮任务到底何时算完成

已核对 **0.7.2 发布包实现**。实际调用相当于以下命令；只读检查请用 `--version` 或子命令 `--help`，**不要用 `create` 做健康检查**。

```text
bdk session create --prod --slug <slug> --message=<带唯一请求标记的文本> --wait --json
bdk session get <ses_id> --prod --slug <slug> --view events --json
# 续接：只在确认配置仍是原部署后提交
bdk session create --prod --slug <原slug> --session <原ses_id> --message=<新一轮文本> --wait --json
```

- `create` 固定走 hosted control plane，解析器接受 `--prod` 但该 flag 对 create 无额外作用；**get 必须带 `--prod`**，不能回落到本地。每次启动只提交一次，不自动重投。`--wait` 默认等至多 120 秒取得 `sessionId`，退出 0 不是回答完成；退出 3 表示投递仍 pending。
- Board 将非机密标识 `grok-prod:<slug>:ses_<24位小写十六进制>` 存入 `task.sessionId`。禁用、没有绑定、绑定格式错误或 slug 已改变时拒绝继续；恢复原 slug 后才可再试。显式重新开始（不是继续）则创建新会话，不发送旧 session ID。不会查“最新会话”、用桌面线程、通过其他 agent 接管、或把 continuation token 发给客户端。
- `get --view events` 是一次性 JSON 快照，不是 NDJSON。Board 每约 3 秒读取一次；它用唯一请求标记识别该次 `message.received`，再用 `turnId` 识别同轮的 `turn.completed` / `turn.failed`。只取顶层 `message.completed.data.text`，否则取完成事件的 `data.result`。忽略历史轮次、嵌套 agent、思考、工具输出与启动日志。**依赖部署保留原始消息文本和这些事件**；例如自定义 `onMessage` 改写文本，会无法关联，而不是误报上一轮成功。CLI 的平台投递 ID 不保证等于运行时 `send()` 写入事件的 ID。
- **Stop = 停止本地观察，不保证取消远端运行或计费。** 没有调用影响同部署其他会话的 `deployment cancel-runs/stop`。投递超时、观察超时（30 分钟）、CLI 出错、事件输出超限（单次 stdout 8 MiB）等都不是成功；远端状态不明时先去 Deployed Agents 核查。必要时由操作者在平台上处置。Board 不支持运行中 steer，不会自动重试写请求。
- Board 不转发 CLI stdout/stderr、trace、请求参数、工具输出或凭据。只保存选出的最终助理正文；**正文是面向 Board 用户的数据**，不能把带秘密的部署当作安全脱敏服务。提示通过 CLI 参数发送，同机高权限用户可能看到；用专用运行账号，不在提示中放密钥。

## 可复核的上游依据

固定版本的 [npm 发布包](https://registry.npmjs.org/@grok/agent-sdk/-/agent-sdk-0.7.2.tgz)：[命令解析](https://unpkg.com/@grok/agent-sdk@0.7.2/dist/internal/cli/commands/session.js)、[托管提交、等待与续接](https://unpkg.com/@grok/agent-sdk@0.7.2/dist/internal/cli-ax.js)、[事件快照输出](https://unpkg.com/@grok/agent-sdk@0.7.2/dist/internal/hosted-session-view.js)、[回答/终态提取语义](https://unpkg.com/@grok/agent-sdk@0.7.2/dist/internal/trajectory.js)、[部署与认证说明](https://unpkg.com/@grok/agent-sdk@0.7.2/docs/deployment.md)。离线验证：`node_modules/.bin/tsx --test src/runners/grok.test.ts`。测试只使用临时的假 CLI，不需要 Cursor 账号。
