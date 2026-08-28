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
#
# 端口自动管理：无显式指定时从偏好端口（3000/30141）开始探测空闲端口，
# 选中的端口写入 run/ports.env 供下次优先复用；以下途径可固定端口（优先级
# 从高到低）：环境变量 PLATFORM_PORT/WEB_PORT > env 文件里的 PORT= 行 >
# ports.env 记录 > 向上探测。
#
# 可写区定位（AppImage 只读挂载时由 AppRun 指到外部数据目录）:
#   AMEDAC_CONFIG_DIR  默认 <包>/sandbox        （platform.env / piweb.env）
#   AMEDAC_RUN_DIR     默认 <包>/run
#   AMEDAC_LOG_DIR     默认 <包>/logs
#   DATA_DIR           默认 <包>/data
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

RUN_DIR="${AMEDAC_RUN_DIR:-$PKG/run}"
LOG_DIR="${AMEDAC_LOG_DIR:-$PKG/logs}"
DATA_DIR="${DATA_DIR:-$PKG/data}"
# 配置独立成 config/ 目录（与 data/run/logs 平级）：tar 原地升级时排除
# config data run logs 即可保住全部用户配置；旧部署的 sandbox/*.env 会
# 自动搬迁过来（原件留 .v1 备份）。
CONFIG_DIR="${AMEDAC_CONFIG_DIR:-$PKG/config}"
if [ ! -f "$CONFIG_DIR/platform.env" ] && [ -f "$PKG/sandbox/platform.env" ]; then
  mkdir -p "$CONFIG_DIR"
  for f in platform.env piweb.env admin-password.txt; do
    if [ -f "$PKG/sandbox/$f" ]; then
      cp -a "$PKG/sandbox/$f" "$CONFIG_DIR/$f"
      mv "$PKG/sandbox/$f" "$PKG/sandbox/$f.v1-backup"
    fi
  done
fi
mkdir -p "$RUN_DIR" "$LOG_DIR" "$DATA_DIR" "$CONFIG_DIR"

PLATFORM_DIR="$PKG/sandbox/platform"
EXTENSION_DIR="$PKG/sandbox/extension"
PLATFORM_ENV_FILE="$CONFIG_DIR/platform.env"
WEB_ENV_FILE="$CONFIG_DIR/piweb.env"
ADMIN_PW_FILE="$CONFIG_DIR/admin-password.txt"
[ -d "$PLATFORM_DIR" ] || { echo "ERROR: 包内未找到 sandbox/platform（请使用包含沙盒组件的分发包重新打包）" >&2; exit 1; }

START_WEB=1
[ "${1:-}" = "--no-web" ] && START_WEB=0

log()  { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

# ---- 端口解析：显式 > env 文件固定 > 上次记录 > 向上探测 ----
port_free() { # port -> 0/1（用打包内置 node 探测，跨发行版可靠）
  "$NODE_BIN" -e 'const n=require("net").createServer();n.once("error",()=>process.exit(1));n.listen(Number(process.argv[1]),"0.0.0.0",()=>n.close(()=>process.exit(0)))' "$1" >/dev/null 2>&1
}
env_file_has_port() { # file namesRegex -> 打印固定值或空（仅认用户手写的行）
  [ -f "$1" ] && grep -E "^($2)=" "$1" 2>/dev/null | head -n 1 | cut -d= -f2 | tr -d '[:space:]'
}
resolve_port() { # <名字> <偏好端口> <env文件> <env文件里的别名正则> -> 打印端口
  local name="$1" prefer="$2" envfile="$3" aliasre="$4" p
  p="${!name:-}"
  if [ -n "$p" ]; then printf '%s' "$p"; return 0; fi                      # ① 环境变量
  p="$(env_file_has_port "$envfile" "$aliasre")"
  if [ -n "$p" ]; then printf '%s' "$p"; return 0; fi                      # ② env 文件显式固定
  local recfile="$RUN_DIR/ports.env"
  p="$(env_file_has_port "$recfile" "$name")"
  if [ -n "$p" ] && port_free "$p"; then printf '%s' "$p"; return 0; fi    # ③ 上次记录仍空闲
  p="$prefer"                                                              # ④ 从偏好端口向上探测
  local tries=0
  while ! port_free "$p" && [ "$tries" -lt 100 ]; do
    p=$((p + 1)); tries=$((tries + 1))
  done
  printf '%s' "$p"
}

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
# 0. 端口解析 + 目标机前置检查
# ---------------------------------------------------------------------------
# 解析顺序（见文件头注释）：环境变量 > env 文件显式 PORT= 行 > ports.env >
# 从偏好端口向上探测。解析完成后立即落盘 ports.env，供 AppRun 开浏览器、
# stop/status 兜底使用。
mkdir -p "$RUN_DIR"
PLATFORM_PORT="$(resolve_port PLATFORM_PORT 3000 "$PLATFORM_ENV_FILE" 'PORT|PLATFORM_PORT')"
if [ "$START_WEB" = "1" ]; then
  WEB_PORT="$(resolve_port WEB_PORT 30141 "$WEB_ENV_FILE" 'PORT|WEB_PORT')"
fi
printf 'PLATFORM_PORT=%s\nWEB_PORT=%s\n' "$PLATFORM_PORT" "${WEB_PORT:-}" > "$RUN_DIR/ports.env"

APPTAINER_BIN="$(command -v apptainer || command -v singularity || true)"
if [ -z "$APPTAINER_BIN" ]; then
  warn "未检测到 apptainer/singularity —— 沙箱容器将无法创建。"
  warn "安装指引: https://apptainer.org/docs/admin/latest/installation.html"
fi

# ---------------------------------------------------------------------------
# 1. 沙盒平台（sandbox-platform）
# ---------------------------------------------------------------------------
start_platform() {
  local generated=0
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
    generated=1
    log "生成默认平台配置: $PLATFORM_ENV_FILE"
    mkdir -p "$(dirname "$PLATFORM_ENV_FILE")"
    # 生产模式强制强密钥：JWT ≥32 字符、管理员密码不能是默认弱值。
    # 管理员密码随机生成并落盘 admin-password.txt（仅属主可读），
    # 登录后可在 WebUI 内修改，改完可删掉该文件。
    # 注意：端口不在本文件里——由 start-all 自动探测并记忆在 run/ports.env；
    # 要固定端口就在此文件加一行 PORT=xxxx（优先级高于自动探测）。
    JWT="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    ADMIN_PW="ame-$(head -c 12 /dev/urandom | base64 | tr -d '=+/')A7"
    cat > "$PLATFORM_ENV_FILE" <<EOF
# sandbox-platform 配置（本文件由 start-all.sh 首次运行生成，可自由编辑）
# 固定端口：加一行 PORT=xxxx（不设则每次自动探测空闲端口）
NODE_ENV=production
HOST=127.0.0.1
DB_DIALECT=sqlite
DB_SQLITE_PATH=$DATA_DIR/platform/sandbox.db
JWT_SECRET=$JWT
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=$ADMIN_PW
REGISTER_MODE=off
EXECUTOR_KIND=${SANDBOX_EXECUTOR_KIND:-apptainer-cli}
OVERLAY_BASE_DIR=$DATA_DIR/platform/overlays
TRUST_PROXY=0
EOF
    printf '%s\n' "$ADMIN_PW" > "$ADMIN_PW_FILE"
    chmod 600 "$PLATFORM_ENV_FILE" "$ADMIN_PW_FILE"
    warn "管理员账号（平台与 WebUI 共用）: admin / 初始密码见 $(basename "$CONFIG_DIR")/admin-password.txt"
    warn "首次登录后请立即修改密码，并可删除该密码文件。"
  fi

  [ -f "$PLATFORM_DIR/.env" ] && \
    warn "检测到 sandbox/platform/.env：平台的 dotenv 会加载它（已导出的环境变量优先）。确认这是你有意保留的配置。"

  mkdir -p "$DATA_DIR/platform"
  grep -q "^SEED_ADMIN_PASSWORD=" "$PLATFORM_ENV_FILE" && grep -q "^DB_SQLITE_PATH=" "$PLATFORM_ENV_FILE" || {
    warn "platform.env 缺少关键字段（旧版生成物或不完整的手写文件）。"
    warn "修复：删除 $PLATFORM_ENV_FILE 后重跑可重新生成（新密钥+新管理员密码）；"
    warn "升级前的旧配置如有备份，在同级 *.v1-backup 文件里。"
    return 1
  }

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

  if [ "$generated" = "1" ] && command -v curl >/dev/null 2>&1; then
    local pw probe=""
    pw="$(head -n 1 "$ADMIN_PW_FILE" 2>/dev/null || true)"
    probe="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PLATFORM_PORT/api/v1/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"admin\",\"password\":\"$pw\"}" 2>/dev/null || echo 000)"
    if [ "$probe" = "200" ]; then
      log "管理员登录自检通过（admin / admin-password.txt）"
    else
      warn "管理员登录自检失败（HTTP $probe）：若这不是全新数据目录，说明 db 里是旧凭证；新库则检查 .env 冲突。"
    fi
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
    # 平台地址也不写死在文件里——每次按实际探测到的平台端口注入；
    # 要固定就加一行 PI_WEB_PLATFORM_URL=http://…（优先级高于自动注入）。
    cat > "$WEB_ENV_FILE" <<EOF
# pi-web 配置（本文件由 start-all.sh 首次运行生成，可自由编辑）
# 平台地址默认自动跟随探测到的平台端口；固定：加一行 PI_WEB_PLATFORM_URL=http://…
PI_WEB_AUTH=on
PI_WEB_DATA_DIR=$DATA_DIR/piweb
PI_WEB_SANDBOX_EXTENSION_PATH=$EXTENSION_DIR
PI_WEB_LAB_TRAINING=off
EOF
    chmod 600 "$WEB_ENV_FILE"
    warn "WebUI 与沙盒平台共用同一套账号（WebUI 登录即平台登录）。"
    warn "首次登录用 admin 和 admin-password.txt 里的初始密码，登录后请修改。"
  fi

  mkdir -p "$DATA_DIR/piweb"
  log "启动 WebUI (port $WEB_PORT) …"
  (
    cd "$PKG/app"
    set -a; . "$WEB_ENV_FILE"; set +a
    export PORT="$WEB_PORT"
    # 平台地址跟随本次探测结果（env 文件里显式写了则以文件为准）
    export PI_WEB_PLATFORM_URL="${PI_WEB_PLATFORM_URL:-http://127.0.0.1:$PLATFORM_PORT}"
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
