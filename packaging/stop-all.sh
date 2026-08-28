#!/usr/bin/env bash
#
# stop-all.sh — 停止 start-all.sh 启动的服务（沙盒平台 / WebUI）。
# 以 run/*.pid 为准；pid 文件缺失时按端口兜底查找。
set -uo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  TARGET="$(readlink "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *)  SOURCE="$(dirname "$SOURCE")/$TARGET" ;;
  esac
done
SCRIPTS="$(cd "$(dirname "$SOURCE")" && pwd)"
PKG="$(cd "$SCRIPTS/.." && pwd)"
RUN_DIR="${AMEDAC_RUN_DIR:-$PKG/run}"
# 端口兜底顺序：环境变量 > run/ports.env（自动探测的记录）> 默认值
PORTS_FILE="$RUN_DIR/ports.env"
PLATFORM_PORT="${PLATFORM_PORT:-$(grep -E '^PLATFORM_PORT=' "$PORTS_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')}"
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$PORTS_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')}"
PLATFORM_PORT="${PLATFORM_PORT:-3000}"
WEB_PORT="${WEB_PORT:-30141}"

stop_pid() { # name pid
  local name="$1" pid="$2"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || { echo ">> $name: 未在运行"; return 0; }
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo ">> $name: 10s 未退出，强制结束 (pid $pid)"
    kill -9 "$pid" 2>/dev/null || true
  fi
  echo ">> $name: 已停止 (pid $pid)"
}

# WebUI（先停上层，再停平台）
if [ -f "$RUN_DIR/web.pid" ]; then
  stop_pid "WebUI" "$(cat "$RUN_DIR/web.pid")"
  rm -f "$RUN_DIR/web.pid"
else
  BYPORT="$(ss -tlnp 2>/dev/null | grep ":$WEB_PORT " | grep -oP 'pid=\K[0-9]+' | head -n 1 || true)"
  [ -n "$BYPORT" ] && stop_pid "WebUI(按端口)" "$BYPORT" || echo ">> WebUI: 未在运行"
fi

if [ -f "$RUN_DIR/platform.pid" ]; then
  stop_pid "沙盒平台" "$(cat "$RUN_DIR/platform.pid")"
  rm -f "$RUN_DIR/platform.pid"
else
  BYPORT="$(ss -tlnp 2>/dev/null | grep ":$PLATFORM_PORT " | grep -oP 'pid=\K[0-9]+' | head -n 1 || true)"
  [ -n "$BYPORT" ] && stop_pid "沙盒平台(按端口)" "$BYPORT" || echo ">> 沙盒平台: 未在运行"
fi
