# 文档站部署

线上地址：**https://relay.mengfei.tech/docs/**。

Docusaurus 配置使用 `url: https://relay.mengfei.tech`、`baseUrl: /docs/`、`trailingSlash: true`。文档根路由为 `/`，因此文档页面均位于 `/docs/` 下，不会产生 `/docs/docs/`。

## 构建与更新

在仓库根目录执行：

```bash
pnpm docs:build
```

把下列文件放入部署机 `/opt/agent-board-docs/`（不要上传 `node_modules` 或环境密钥）：

```text
Dockerfile          # website/deploy/Dockerfile
nginx.conf          # website/deploy/nginx.conf
docker-compose.yml  # website/deploy/docker-compose.yml
build/              # website/build/ 的完整内容
```

在部署机目录设置独立版本并更新文档容器：

```bash
cd /opt/agent-board-docs
# 版本号取本次源码 commit；在 .env 中持久保存，便于后续 compose 操作。
printf 'DOCS_VERSION=<commit>\n' > .env
docker compose up -d --build --wait --wait-timeout 60 agent-board-docs
```

静态镜像不包含中继代码或任何令牌。容器不发布宿主机端口，只加入现有 `1panel-network`，内部监听 `8080`。更新文档不需要重启 `agent-board-relay`。

## 反向代理

在 Nginx Proxy Manager 的 `relay.mengfei.tech` Proxy Host **Advanced** 中保留现有内容，追加 [`proxy-location.conf`](./proxy-location.conf)。必须同时保存到 NPM 配置数据库，不能只编辑自动生成的 `/data/nginx/proxy_host/9.conf`，否则后续保存代理配置会覆盖路由。

- `/docs` 返回 308 到 `/docs/`。
- `/docs/` 转发到 `http://agent-board-docs:8080`，保留 URI 前缀。
- 文档是公开静态内容，不向文档容器转发 Authorization 或 Cookie。
- 原有 `/` 中继、`/admin`、`/api/admin/state`、`/v1/ws` 路由保持不变。
- 先备份当前 Proxy Host 配置和 Advanced 字段，运行 `nginx -t` 成功后再平滑重载。

首次部署备份在服务器 `/opt/agent-board-docs-backups/20261103T034325Z/`。回滚路由时恢复原 Advanced 字段并让 NPM 重新生成配置，检查语法后平滑重载；不要替换整个 NPM 数据库，以免覆盖其他代理的更新。回滚文档内容时使用保留的旧版本镜像并执行 `docker compose up -d --no-build --wait`。

## 验证

- `/docs` → 308；`/docs/`、`/docs/architecture/` 和 `/docs/api/overview/` → 200。
- HTML 中脚本与样式路径以 `/docs/assets/` 开头，站内链接均位于 `/docs/`；未知文档路径 → 404。
- `/admin` 与 `/health` 仍为 200；匿名 `/api/admin/state` 仍为 401。
- 浏览器检查文档导航、刷新深层页面、架构图和窄屏布局。
- `agent-board-docs` 与 `agent-board-relay` 容器健康，中继容器启动时间不变。
