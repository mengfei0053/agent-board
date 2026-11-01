#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
action="${1:-restart}"
if [[ "$action" == -h || "$action" == --help ]]; then
  cat <<'EOF'
用法: ./scripts/board.sh [start|restart]

  start       启动看板；如果端口已占用则退出
  restart     启动或重启看板（默认）；运行中有任务时不会重启
  -h, --help  显示帮助

脚本加载项目根目录的 .env.relay。日志默认写入 /tmp/agent-board-server.log。
EOF
  exit 0
fi
if [[ "$action" != start && "$action" != restart ]]; then
  echo "用法: $0 [start|restart]" >&2
  exit 1
fi
for cmd in curl fuser flock node; do
  command -v "$cmd" >/dev/null || { echo "缺少命令: $cmd" >&2; exit 1; }
done
[[ -x "$ROOT/node_modules/.bin/tsx" && -f "$ROOT/.env.relay" ]] || {
  echo "缺少依赖或 .env.relay；请先安装依赖并配置中继。" >&2
  exit 1
}

# Both scripts read the same configuration; environment variables such as
# DATABASE_URL may also be supplied by the caller.
set -a
source "$ROOT/.env.relay"
set +a
port="${PORT:-8791}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port > 0 && port <= 65535 )) || { echo "PORT 无效。" >&2; exit 1; }
log="${AGENT_BOARD_LOG:-/tmp/agent-board-server.log}"
exec 9>"/tmp/agent-board-${UID}-${port}.lock"
flock -n 9 || { echo "已有启动或重启操作正在进行。" >&2; exit 1; }

listeners() { fuser -n tcp "$port" 2>/dev/null || true; }
current="$(listeners)"
if [[ -n "$current" ]]; then
  if [[ "$action" == start ]]; then
    echo "端口 $port 已被占用；如需重启，请使用 $0 restart。" >&2
    exit 1
  fi
  read -r -a pids <<< "$current"
  if (( ${#pids[@]} != 1 )); then echo "端口 $port 有多个进程，无法安全重启。" >&2; exit 1; fi
  pid="${pids[0]}"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  args="$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$cwd" != "$ROOT" ]] || ! printf '%s\n' "$args" | grep -Fxq 'src/server.ts'; then
    echo "端口 $port 不属于当前项目的看板进程，未停止该进程。" >&2
    exit 1
  fi
  if ! curl -fsS --max-time 5 "http://127.0.0.1:$port/api/tasks" | node -e '
    let input = ""; process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => { try {
      const data = JSON.parse(input);
      if (!Array.isArray(data.tasks)) process.exit(2);
      const count = data.tasks.filter(task => task.status === "running").length;
      if (count) { console.error(`还有 ${count} 个运行中的任务，请等待任务结束后重启。`); process.exit(1); }
    } catch { process.exit(2); } });'; then
    echo "未重启看板；请检查运行中的任务和看板连接。" >&2
    exit 1
  fi
  echo "正在停止看板…"
  kill -TERM "$pid"
  for ((i=0; i<30; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then echo "看板未在 30 秒内退出，未强制停止。" >&2; exit 1; fi
fi

if [[ -n "$(listeners)" ]]; then echo "端口 $port 仍被占用，未启动。" >&2; exit 1; fi
echo "正在启动看板…"
nohup "$ROOT/scripts/start-with-relay.sh" </dev/null >/dev/null 2>&1 9>&- &
new_pid=$!
for ((i=0; i<30; i++)); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    echo "看板已启动：http://127.0.0.1:$port"
    echo "日志：$log"
    exit 0
  fi
  if ! kill -0 "$new_pid" 2>/dev/null; then break; fi
  sleep 1
done
echo "看板未能启动，请查看日志：$log" >&2
exit 1
