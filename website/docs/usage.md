---
sidebar_position: 3
title: 使用指南
---

## 工作区与任务

在侧栏添加工作区并选择目录。新建草稿只保存任务；新建 Todo 会创建并运行任务。任务卡片位于对应状态的泳道中，可以拖动卡片更改状态。

打开任务详情可查看实时输出和状态，也可以停止运行。任务结束后可按 CLI session 继续运行，或将已完成的任务归档。

## 全局用量查询

点击左上角品牌菜单的「用量查询」，按时间、Agent、供应商或模型查看四项指标、趋势和全历史热力图。图下有可分页的请求日志、独立供应商与模型统计，支持点击记录查看来源。日志包含轮次，不能把条数当作 API 请求数。未知和部分覆盖会标出，默认只统计本 Board 的任务。详见[全局用量查询手册](https://github.com/mengfei0053/agent-board/blob/main/docs/global-usage.md)。

## Git worktree

当工作区是带有可用 HEAD 的 Git 仓库根目录时，创建任务可以选择在 worktree 中启动。看板会在工作区下的 `.agent-board/worktrees/<任务 id>` 创建目录及对应分支。删除任务时，干净的 worktree 会被移除；有未提交改动的 worktree 会保留。

请自行将 `.agent-board/` 添加到仓库的 `.gitignore` 或本机 excludesfile。

## 手机远程访问

看板支持通过 Relay 和 Android 客户端远程操作。默认不启用 Relay；配置中继后，可在看板的「设置 → 手机配对」生成一次性配对码。

配置方法、环境变量和部署限制见 [README 的手机遥控 / Relay 章节](https://github.com/mengfei0053/agent-board#手机遥控--relay)。
