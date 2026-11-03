---
sidebar_position: 1
title: API 概览
description: 看板后端 HTTP/SSE 与 Relay HTTP/WebSocket 接口入口、鉴权和调用方式。
---

Agent Board 有两套独立的服务接口。本文档可直接在文档站查阅，不需要先启动本机看板。

| 服务 | 默认地址 | 用途 | 接口文档 |
| --- | --- | --- | --- |
| 看板后端 | `http://127.0.0.1:8791` | 工作区、任务执行、设置、上传与实时事件 | [看板 HTTP / SSE API](./board.md) |
| Relay 中继 | `http://127.0.0.1:8787`、`ws://127.0.0.1:8787/v1/ws` | 设备配对、凭证管理、远程命令与事件转发 | [Relay HTTP API](./relay-http.md)、[Relay WebSocket API](./relay-websocket.md) |

部署到公网时，应在 Relay 前配置 TLS 反向代理，客户端使用 `https://` 和 `wss://`。修改 `HOST` / `PORT` 后请替换示例地址。

## 选择哪套接口

- **本机脚本或 Web 看板**：调用看板 HTTP API，通过 `/api/events`（SSE）接收状态和日志。
- **外部系统创建任务**：优先调用带独立密钥的看板 Webhook `/api/hooks/tasks`。
- **Android 或自建远程客户端**：通过 Relay HTTP 接口配对，随后连接 `/v1/ws` 发送命令和订阅事件。Relay 没有 `/api/tasks` 这样的任务 REST 接口。
- **中继运维**：使用 `ADMIN_TOKEN` 调用 Relay 管理 HTTP 接口；`/admin` 提供管理页面。

Relay 不执行 CLI、不主动访问看板 HTTP，也不保存任务数据库。本机看板主动连接 Relay，由本机处理远程命令。两条链路的职责与时序见 [项目架构](../architecture.md)。

## 鉴权与安全边界

| 凭证 | 使用位置 | 说明 |
| --- | --- | --- |
| 无统一用户凭证 | 本机普通 `/api/*` | 以本机可信访问为前提，不应直接暴露到公网 |
| `AGENT_BOARD_WEBHOOK_SECRET` | 看板 Webhook 的 Bearer 或 `X-Webhook-Secret` 请求头 | 未配置时 Webhook 返回 `503` |
| `ADMIN_TOKEN` | Relay 管理 HTTP 的 `Authorization: Bearer …` | 生成配对码、签发和撤销凭证、读取管理状态 |
| `BOARD_TOKEN` / 签发的 `boardToken` | WebSocket `board.register` 首帧 | 注册授权范围内的看板，不能代替设备凭证 |
| `deviceToken` | `/auth/refresh` JSON；WebSocket `client.hello` 首帧 | 由一次性配对码换取，限定设备和可访问的看板 |

不要把令牌放进 URL、日志或前端持久化的公开配置。看板设置页的配对接口只临时使用管理员令牌，不保存该令牌。

## 响应格式与模型差异

- HTTP 请求体除上传外使用 JSON；上传使用 `multipart/form-data`。
- 看板错误通常是 `{"error":"message"}`；Relay HTTP 错误是 `{"error":{"code":"bad_request","message":"message"}}`。
- WebSocket 每条消息使用 `v`、`id`、`type`、`ts`、`payload` 信封，响应通过 `payload.ref` 关联请求。
- 看板任务使用 `kind`、ISO 时间字符串和 `blocked` 状态；Relay 任务使用 `agent`、Unix 毫秒时间戳和 `paused` 状态，不能混用两种模型。
- HTTP 创建成功、WebSocket 命令 `executed` 都不代表 Agent 已完成；任务终态由后续事件反映。

## 实现依据

文档按当前仓库实现整理：看板路由位于 `src/server.ts`，Relay HTTP 路由位于 `relay/src/server.ts`，WebSocket 校验与路由位于 `relay/src/protocol.ts`、`relay/src/hub.ts`。完整线协议说明另见仓库 [PROTOCOL.md](https://github.com/mengfei0053/agent-board/blob/HEAD/PROTOCOL.md)。

接口文档描述当前源码，不代表已部署实例已经升级；调用新增能力前应核对服务版本以及 `board.list` 返回的 `capabilities`。
