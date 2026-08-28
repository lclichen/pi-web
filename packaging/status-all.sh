#!/usr/bin/env bash
#
# status-all.sh — 查看沙盒平台 / WebUI 运行状态与最近日志位置。
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
LOG_DIR="${AMEDAC_LOG_DIR:-$PKG/logs}"
# 端口兜底顺序：环境变量 > run/ports.env（自动探测的记录）> 默认值
PORTS_FILE="$RUN_DIR/ports.env"
PLATFORM_PORT="${PLATFORM_PORT:-$(grep -E '^PLATFORM_PORT=' "$PORTS_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')}"
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$PORTS_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')}"
PLATFORM_PORT="${PLATFORM_PORT:-3000}"
WEB_PORT="${WEB_PORT:-30141}"

report() { # name pid_file port health_url log_file
  local name="$1" pid_file="$2" port="$3" url="$4" logfile="$5"
  local pid="" state="未运行" http="-"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file")"
    kill -0 "$pid" 2>/dev/null || pid=""
  fi
  [ -z "$pid" ] && pid="$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -n 1 || true)"
  [ -n "$pid" ] && state="运行中 (pid $pid)"
  if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
    http="HTTP OK"
  fi
  printf '%-10s %-24s 端口 %-6s %s\n' "$name" "$state" "$port" "$http"
  echo "           日志: ${logfile##*/} （tail -f $logfile）"
}

echo "===== amedac.ai 服务状态 ====="
report "沙盒平台" "$RUN_DIR/platform.pid" "$PLATFORM_PORT" "http://127.0.0.1:$PLATFORM_PORT/health" "$LOG_DIR/platform.log"
report "WebUI"    "$RUN_DIR/web.pid"     "$WEB_PORT"     "http://127.0.0.1:$WEB_PORT/"           "$LOG_DIR/web.log"

if command -v apptainer >/dev/null 2>&1; then
  echo ""
  echo "apptainer: $(command -v apptainer) ($(apptainer --version 2>/dev/null | head -n 1))"
else
  echo ""
  echo "警告: 未检测到 apptainer —— 沙箱容器功能不可用（安装见 docs/DEPLOYMENT.md）"
fi
