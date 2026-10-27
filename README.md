# agent-board

本机 Web 看板：新建并管理 **pi / Claude Code / Cursor CLI** 正在跑的任务。

## 要求

- Node 20+（ThinkBook 已有）
- 本机已安装并可在 PATH 里找到：`pi`、`claude`、`agent`

## 启动

```bash
cd ~/projects/agent-board
pnpm install   # 或 npm i / bun i
pnpm dev
```

浏览器打开 http://127.0.0.1:8791

## 能力（v0.1）

- 创建任务并在指定 cwd 启动对应 CLI（非交互、可脚本化模式）
- 列表 / 详情 / 实时日志（SSE）
- 停止任务

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)
