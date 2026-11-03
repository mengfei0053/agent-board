---
sidebar_position: 3
title: Relay HTTP API
description: Relay 中继服务的健康检查、设备配对、令牌轮换、撤销和管理状态接口。
---

默认 Base URL：`http://127.0.0.1:8787`。公网客户端应使用 TLS 代理后的 `https://` 地址。任务操作通过 [WebSocket API](./relay-websocket.md)，不是此处的 HTTP 接口。

## 通用约定

- 除 GET 外，业务请求使用 JSON 对象，推荐 `Content-Type: application/json`；请求体最大 **64 KiB**。
- HTTP 响应带 `Cache-Control: no-store`。时间戳 `expiresAt` / `connectedAt` 均为 Unix 毫秒，`uptimeSec` 为秒。
- 管理接口要求 `Authorization: Bearer $ADMIN_TOKEN`。不能以 boardToken 或 deviceToken 代替。
- 管理请求按 TCP 对端 IP 限制为 **60 次/分钟**，包括令牌校验失败的请求。配对尝试另有默认 **8 次/60 秒** 限制，由 `PAIR_ATTEMPT_LIMIT` / `PAIR_WINDOW_MS` 控制。当前不读取 `X-Forwarded-For`；反向代理后的请求可能共享限额。
- JSON 响应提供 CORS `*`，允许 `Content-Type` / `Authorization`，方法 GET / POST / OPTIONS。OPTIONS 返回 `204`；CORS 不替代鉴权。

错误格式：

```json
{"error":{"code":"unauthorized","message":"admin token rejected"}}
```

| HTTP 状态 | 常见 code | 含义 |
| --- | --- | --- |
| 400 | `bad_request` | 参数、JSON 或 TTL 不合法 |
| 401 | `unauthorized` | 管理令牌、配对码或设备令牌被拒绝 |
| 404 | `not_found` | 路径或待撤销资源不存在 |
| 405 | `method_not_allowed` | 已知业务路径使用错误方法，响应含 Allow |
| 413 | `payload_too_large` | 请求体超过 64 KiB |
| 429 | `rate_limited` | 管理请求或配对尝试限流 |
| 500 | `internal` | 内部错误，外部只收到通用错误消息 |

## 接口索引

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | 不含标识和令牌的服务计数 |
| GET | `/api/admin/state` | admin Bearer | 看板、设备和配对码状态 |
| POST | `/auth/pair/create` | admin Bearer | 创建一次性配对码 |
| POST | `/auth/pair` | 请求体中的配对码 | 换取设备凭证 |
| POST | `/auth/refresh` | 请求体中的设备令牌 | 轮换设备凭证 |
| POST | `/auth/revoke/device` | admin Bearer | 撤销设备并断开连接 |
| POST | `/auth/revoke/board` | admin Bearer | 撤销看板令牌或看板 ID |
| POST | `/auth/board/issue` | admin Bearer | 签发限定看板的新令牌 |

`GET` / `HEAD /admin`、`/admin/` 是管理页面，`/admin/admin.css`、`/admin/admin.js` 是静态资源，不是 JSON API。页面本身可加载，管理数据仍需管理员令牌。`/api/admin/state` 与管理页面是当前工作区中的新增实现，部署旧版本时可能尚不存在。

## GET `/health`

无需鉴权，成功 `200`：

```json
{
  "ok": true,
  "service": "agent-board-relay",
  "protocol": 1,
  "uptimeSec": 42,
  "boardsOnline": 1,
  "phonesOnline": 2,
  "pairedDevices": 2
}
```

仅提供计数，不返回 boardId、设备信息或令牌。phonesOnline 统计已认证连接，pairedDevices 统计有效已配对设备；这不是某个本机看板数据库的健康检查。

## POST `/auth/pair/create`

管理员创建绑定一个或多个看板的一次性配对码。

```bash
curl -X POST http://127.0.0.1:8787/auth/pair/create \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"boardIds":["thinkbook-main"],"ttlMs":300000}'
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `boardIds` | 是 | 1–20 个看板 ID；重复值去重；单个满足 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` |
| `ttlMs` | 否 | 整数，最少 1,000，最多 `PAIR_TTL_MS`；省略取配置值，默认 300,000（5 分钟） |

成功 `200`：

```json
{"pairCode":"pc_EXAMPLE","boardIds":["thinkbook-main"],"expiresAt":1793527500000}
```

实际 pairCode 为 `pc_` 加 32 随机字节的 base64url（后缀 43 字符）；示例为占位值。看板不需要在线才能生成配对码。配对码成功兑换后立即失效，过期也不能再用；不要把它当作长期令牌。

## POST `/auth/pair`

不需要 Bearer 请求头，通过请求体证明持有配对码。

```json
{"pairCode":"pc_EXAMPLE","deviceName":"Pixel 8"}
```

`pairCode` 必填字符串；`deviceName` 可选，默认 `phone`，去空白后长度 1–80。成功 `200`：

```json
{
  "deviceId": "dev_0123456789abcdef",
  "deviceToken": "dt_EXAMPLE",
  "role": "phone",
  "boardIds": ["thinkbook-main"],
  "expiresAt": 1794132000000
}
```

deviceToken 绑定此 deviceId、phone 角色和 boardIds，默认有效期 7 天，由 `TOKEN_TTL_MS` 控制。保存到安全存储后，在 WebSocket 首帧 `client.hello` 使用。无效/过期/已使用配对码返回 `401`，尝试过多为 `429`。重复兑换不会返回原设备令牌。

## POST `/auth/refresh`

```json
{"deviceToken":"dt_OLD"}
```

成功 `200`，结构与 pair 相同；deviceId、role、boardIds 不变，deviceToken 和 expiresAt 更新。旧令牌立即失效，其关联的旧 WebSocket 会被关闭，客户端须保存新令牌后重新连接和认证。

无效、过期或已撤销令牌返回 `401`。此接口不是延长原令牌：响应丢失后不能依赖旧令牌重复刷新成功。

## POST `/auth/revoke/device`

要求 admin Bearer，请求：

```json
{"deviceId":"dev_0123456789abcdef"}
```

成功 `200 {"ok":true,"deviceId":"dev_0123456789abcdef"}`，撤销该设备凭证并关闭关联连接。找不到可撤销记录返回 `404 not_found`。重新配对会创建新的设备标识。

## POST `/auth/board/issue`

要求 admin Bearer，请求 `{boardIds:["thinkbook-main"]}`，ID 数量与格式同 pair/create。

成功 `200 {boardToken,boardIds}`；新 token 以 `bt_` 开头，仅可注册返回的看板。将它更新到相应本机看板的 Relay 配置后重新连接。

:::warning 这是轮换，不是追加凭证
签发会撤销所有覆盖任一目标 boardId 的旧凭证，包括初始 `BOARD_TOKEN`，并断开使用这些凭证的连接。若某个旧凭证同时覆盖其他看板，这些看板也可能受影响。接口也会解除目标 boardId 的撤销标记。请安排凭证更新，不要在不了解影响时调用。
:::

## POST `/auth/revoke/board`

要求 admin Bearer，支持两种请求：

| 请求体 | 行为 | 成功响应 |
| --- | --- | --- |
| `{boardToken:"…"}` | 撤销匹配的有效凭证，断开使用它的看板连接；未找到为 404 | `200 {ok:true}` |
| `{boardId:"thinkbook-main"}` | 标记该 ID 已撤销，撤销覆盖该 ID 的凭证并断开相关连接；ID 格式不合法为 400 | `200 {ok:true,boardId}` |

同时传入字符串 boardToken 和 boardId 时，优先 token 分支。按 ID 撤销可能影响共享凭证中的其他看板。之后可通过 board/issue 为目标看板重新签发；撤销 board 并不等同于撤销手机 deviceToken，也不会停止本机运行中的任务。

## GET `/api/admin/state`

要求 admin Bearer，成功 `200` 返回管理元数据：

```json
{
  "service": "agent-board-relay",
  "protocol": 1,
  "uptimeSec": 42,
  "activePairCodes": 0,
  "boards": [{
    "boardId": "thinkbook-main",
    "revoked": false,
    "credentialActive": true,
    "online": true,
    "label": "ThinkBook",
    "connectedAt": 1793527200000,
    "capabilities": ["archive.list","archive.write","workspace.settings","board.settings"],
    "generation": 1,
    "lastSeq": 12
  }],
  "devices": [{
    "deviceId": "dev_0123456789abcdef",
    "deviceName": "Pixel 8",
    "role": "phone",
    "boardIds": ["thinkbook-main"],
    "expiresAt": 1794132000000,
    "online": true,
    "connections": 1
  }]
}
```

- `boards` 包含 Relay 已知的 ID，来源包括注册、凭证、配对与设备授权；不是扫描所有可能的看板。
- `credentialActive` 表示仍有有效凭证能注册此看板，不代表它当前在线。
- 离线看板 `label` / `connectedAt` 为 null，`capabilities` 为空数组；generation/lastSeq 是缓存的运行代次与序号，无运行记录时为 0。
- `devices` 是有效设备会话的元数据；connections 是当前有效已认证连接数。
- `activePairCodes` 为未过期且未消费的数量，不返回配对码。

接口不返回令牌、配对码哈希、任务内容或日志；但设备名称与授权关系仍属管理信息，不能公开暴露。

## 内存与部署边界

Relay 的配对码、设备令牌、看板凭证轮换/撤销状态、命令结果和事件缓存均为进程内数据，**重启不会恢复**。重启后需要重新配对和注册；启动配置中的 BOARD_TOKEN 会重新初始化，不能把内存撤销当作永久禁用。

本机看板通过 `/api/settings/pair-code` 代理生成配对码的调用方式见 [看板 API](./board.md#post-apisettingspair-code)。远程命令的权限、capabilities、幂等与同步恢复见 [Relay WebSocket API](./relay-websocket.md)。
