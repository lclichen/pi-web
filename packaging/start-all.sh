#!/usr/bin/env bash
#
# start-all.sh — 一键启动沙盒教学平台全套服务：
#
#   1. sandbox-platform （容器管理 API，默认 127.0.0.1:3000）
#   2. pi-web           （WebUI，默认 0.0.0.0:30141）
#
# 幂等：已在运行的服务会被跳过（以 run/*.pid 为准）。配置优先读取
# sandbox/platform.env 与 sandbox/piweb.env（不存在且为首次运行时自动生成
# 可用的默认配置，密钥持久化，之后重复使用）。
#
# 用法:
#   ./scripts/start-all.sh            # 启动全部
#   ./scripts/start-all.sh --no-web   # 只启动沙盒平台
#   PLATFORM_PORT=3000 WEB_PORT=30141 ./scripts/start-all.sh
set -uo pipefail

# 解析脚本真实路径（支持软链调用）
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

NODE_BIN="$PKG/runtime/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "ERROR: 未找到 Node.js（runtime/bin/node 与 PATH 均不可用）" >&2; exit 1; }

RUN_DIR="$PKG/run"
LOG_DIR="$PKG/logs"
DATA_DIR="${DATA_DIR:-$PKG/data}"
mkdir -p "$RUN_DIR" "$LOG_DIR"

PLATFORM_DIR="$PKG/sandbox/platform"
EXTENSION_DIR="$PKG/sandbox/extension"
PLATFORM_ENV_FILE="$PKG/sandbox/platform.env"
WEB_ENV_FILE="$PKG/sandbox/piweb.env"
PLATFORM_PORT="${PLATFORM_PORT:-3000}"
WEB_PORT="${WEB_PORT:-30141}"
[ -d "$PLATFORM_DIR" ] || { echo "ERROR: 包内未找到 sandbox/platform（请使用包含沙盒组件的分发包重新打包）" >&2; exit 1; }

START_WEB=1
[ "${1:-}" = "--no-web" ] && START_WEB=0

log()  { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

wait_http() { # url timeout_seconds
  local i=0 port
  port="$(printf '%s' "$1" | grep -oP ':\K[0-9]+' | tail -n 1)"
  while [ "$i" -lt "$2" ]; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -o /dev/null --max-time 2 "$1" 2>/dev/null && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O /dev/null --timeout=2 "$1" 2>/dev/null && return 0
    elif [ -n "$port" ] && (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 3>&- 3<&- 2>/dev/null || true
      return 0
    fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

port_of_pid() { # pid -> 监听端口或空（预留诊断用途）
  ss -tlnp 2>/dev/null | grep "pid=$1," | grep -oP ':\K[0-9]+' | head -n 1
}
pid_on_port() { # port -> pid 或空
  ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | head -n 1
}

# ---------------------------------------------------------------------------
# 0. 目标机前置检查：apptainer（EXECUTOR_KIND=apptainer-cli 时必需）
# ---------------------------------------------------------------------------
APPTAINER_BIN="$(command -v apptainer || command -v singularity || true)"
if [ -z "$APPTAINER_BIN" ]; then
  warn "未检测到 apptainer/singularity —— 沙箱容器将无法创建。"
  warn "安装指引: https://apptainer.org/docs/admin/latest/installation.html"
fi

# ---------------------------------------------------------------------------
# 1. 沙盒平台（sandbox-platform）
# ---------------------------------------------------------------------------
start_platform() {
  if alive "$RUN_DIR/platform.pid"; then
    log "沙盒平台已在运行 (pid $(cat "$RUN_DIR/platform.pid"))"
    return 0
  fi
  # 端口被其他进程占用（非本包进程）时直接报错，避免“看似启动成功”
  local thief
  thief="$(pid_on_port "$PLATFORM_PORT" || true)"
  if [ -n "$thief" ] && ! alive "$RUN_DIR/platform.pid"; then
    warn "端口 $PLATFORM_PORT 已被 pid $thief 占用；如需更换请设 PLATFORM_PORT=… 重跑"
    return 1
  fi

  if [ ! -f "$PLATFORM_ENV_FILE" ]; then
    log "生成默认平台配置: $PLATFORM_ENV_FILE"
    mkdir -p "$(dirname "$PLATFORM_ENV_FILE")"
    JWT="$(head -c 48 /dev/urandom | base64 | tr -d '=+/' | head -c 48)"
    cat > "$PLATFORM_ENV_FILE" <<EOF
# sandbox-platform 配置（本文件由 start-all.sh 首次运行生成，可自由编辑）
NODE_ENV=production
HOST=127.0.0.1
PORT=$PLATFORM_PORT
DB_DIALECT=sqlite
SQLITE_PATH=$DATA_DIR/platform/sandbox.db
JWT_SECRET=$JWT
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme123
REGISTER_MODE=off
EXECUTOR_KIND=${SANDBOX_EXECUTOR_KIND:-apptainer-cli}
TRUST_PROXY=0
EOF
    warn "平台管理员账号: admin / changeme123 —— 首次登录后请立即修改！"
  fi

  mkdir -p "$DATA_DIR/platform"
  log "启动沙盒平台 (port $PLATFORM_PORT) …"
  (
    cd "$PLATFORM_DIR"
    set -a; . "$PLATFORM_ENV_FILE"; set +a
    export PORT="$PLATFORM_PORT"
    setsid nohup "$NODE_BIN" --experimental-transform-types --no-warnings=ExperimentalWarning src/index.ts \
      > "$LOG_DIR/platform.log" 2>&1 < /dev/null &
    echo $! > "$RUN_DIR/platform.pid"
  )
  if wait_http "http://127.0.0.1:$PLATFORM_PORT/health" 30; then
    log "沙盒平台就绪: http://127.0.0.1:$PLATFORM_PORT （/health OK）"
  else
    warn "沙盒平台 30s 内未通过 /health 就绪，日志见 logs/platform.log"
    tail -n 10 "$LOG_DIR/platform.log" 2>/dev/null | sed 's/^/     /'
    return 1
  fi
}
start_platform || exit 1

# ---------------------------------------------------------------------------
# 2. WebUI（pi-web）
# ---------------------------------------------------------------------------
start_web() {
  if alive "$RUN_DIR/web.pid"; then
    log "WebUI 已在运行 (pid $(cat "$RUN_DIR/web.pid"))"
    return 0
  fi
  # pid 记录已死（崩溃/重启过）而端口被其他进程接管时，直接报错而不是误启
  local thief
  thief="$(pid_on_port "$WEB_PORT" || true)"
  if [ -n "$thief" ]; then
    warn "端口 $WEB_PORT 已被 pid $thief 占用；如需更换请设 WEB_PORT=… 重跑"
    return 1
  fi

  if [ ! -f "$WEB_ENV_FILE" ]; then
    log "生成默认 WebUI 配置: $WEB_ENV_FILE"
    mkdir -p "$(dirname "$WEB_ENV_FILE")"
    cat > "$WEB_ENV_FILE" <<EOF
# pi-web 配置（本文件由 start-all.sh 首次运行生成，可自由编辑）
PI_WEB_AUTH=on
PI_WEB_PLATFORM_URL=http://127.0.0.1:$PLATFORM_PORT
PI_WEB_DATA_DIR=$DATA_DIR/piweb
PI_WEB_SANDBOX_EXTENSION_PATH=$EXTENSION_DIR
PI_WEB_LAB_TRAINING=on
EOF
    warn "WebUI 账号: admin / changeme123 —— 首次登录后请立即修改！"
  fi

  mkdir -p "$DATA_DIR/piweb"
  log "启动 WebUI (port $WEB_PORT) …"
  (
    cd "$PKG/app"
    set -a; . "$WEB_ENV_FILE"; set +a
    export PORT="$WEB_PORT"
    setsid nohup "$NODE_BIN" ./node_modules/next/dist/bin/next start -H 0.0.0.0 -p "$WEB_PORT" \
      > "$LOG_DIR/web.log" 2>&1 < /dev/null &
    echo $! > "$RUN_DIR/web.pid"
  )
  if wait_http "http://127.0.0.1:$WEB_PORT" 30; then
    log "WebUI 就绪: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$WEB_PORT/"
  else
    warn "WebUI 30s 内未就绪，日志见 logs/web.log"
    tail -n 10 "$LOG_DIR/web.log" 2>/dev/null | sed 's/^/     /'
    return 1
  fi
}
if [ "$START_WEB" = "1" ]; then
  start_web || exit 1
  log ""
  log "全部服务已启动:"
  log "  沙盒平台  http://127.0.0.1:$PLATFORM_PORT  (logs/platform.log)"
  log "  WebUI     http://0.0.0.0:$WEB_PORT        (logs/web.log)"
  log "停止: ./scripts/stop-all.sh   状态: ./scripts/status-all.sh"
else
  log "仅沙盒平台已启动（--no-web）"
fi
