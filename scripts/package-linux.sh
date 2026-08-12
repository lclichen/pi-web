#!/usr/bin/env bash
#
# package-linux.sh — 构建 pi-web + pi CLI Agent 的 Linux 离线分发包。
#
# 产物（目录 + 压缩包）:
#   dist/pi-linux-<arch>-<version>.tar.gz   (+ SHA256SUMS)
#   build/package-linux/pi-linux-<arch>/    原始目录，可直接拷贝分发
#
# 用法:
#   bash scripts/package-linux.sh
#
# 环境变量（全部可选）:
#   PI_CODING_AGENT_LOCAL  本地编译的 pi-coding-agent 安装包的路径或 URL：
#                          - 一个 .tgz 压缩包
#                          - 一个已解压的目录（含 package.json）
#                          - 一个 https:// URL（适合 CI 里指向内网/私有源）
#                          设置后，它会在 `next build` 之前替换掉 registry 版本，
#                          并随包进入最终产物，运行时使用本地编译的 SDK。
#                          示例:
#                            PI_CODING_AGENT_LOCAL=/data/pi-coding-agent-0.83.1.tgz
#                            PI_CODING_AGENT_LOCAL=/data/pi-coding-agent-src
#                            PI_CODING_AGENT_LOCAL=https://intranet/pi-coding-agent.tgz
#   NODE_RUNTIME_LOCAL    内置 Node.js 运行时的本地来源，用于不访问 nodejs.org 的
#                         分发场景（优先级最高；设置后既不下载也不复用旧 runtime）:
#                          - 一个 .tar.gz / .tar.xz 包（nodejs.org 官方同格式）
#                          - 一个已解压的目录（node-v*-linux-*/ 或 runtime/ 布局）
#                          - 一个 http(s):// URL（内网镜像）
#                         示例:
#                            NODE_RUNTIME_LOCAL=/data/node-v22.19.0-linux-x64.tar.gz
#                            NODE_RUNTIME_LOCAL=/data/node-v22.19.0-linux-x64
#                            NODE_RUNTIME_LOCAL=https://mirror.internal/node-v22.19.0-linux-x64.tar.gz
#   PI_CONFIG_DIR         要随包分发的 pi 配置模板目录（pi 扩展、模型接口配置等
#                         的规范分发）。指向 ~/.pi 或 ~/.pi/agent 均可（自动识别）。
#                         打包进包内 config/pi/，目标机首次运行时由
#                         packaging/install-pi-config.sh 合并到 ~/.pi/agent。
#                         打包时会排除 sessions/、auth.json、bin/、tmp/ 等
#                         用户数据与敏感文件。默认: <仓库>/pi-config（不存在则跳过）。
#   PI_CONFIG_VERSION     配置模板版本号 (默认: 1)。发布新版包时递增，目标机
#                         据此做配置的增量更新（见 packaging/install-pi-config.sh）。
#   PI_UPDATE_BASE_URL    更新源目录（托管 versions.json）。写入包内
#                         config/update-url.txt，目标机用 ./update.sh 检查更新。
#                         未设置时 update.sh 尝试从 app/package.json 的
#                         repository 字段推导 GitHub Releases 地址。
#   NODE_VERSION          内置 Node.js 运行时版本 (默认: 22.19.0；仅当未设置
#                         NODE_RUNTIME_LOCAL 时用于从 nodejs.org 下载)
#   ARCH                  目标 CPU 架构: x64 | arm64 (默认: x64)
#   OUT_DIR               产物输出目录 (默认: <仓库>/dist)
#   SMOKE_TEST            设为 "0" 跳过构建后的冒烟测试 (默认: 1)
#   SKIP_RUNTIME_DOWNLOAD 设为 "1" 复用包内已有的 runtime/，不再下载 Node
#                         （构建机完全离线时使用；NODE_RUNTIME_LOCAL 优先级更高）
#
# 构建机要求: Linux（或 WSL）、bash、curl（或 wget）、tar、Node.js >= 22
#            （用于安装依赖和执行 next build；产物本身不需要）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/build/package-linux"
SRC="$WORK/src"
ARCH="${ARCH:-x64}"
NODE_VERSION="${NODE_VERSION:-22.19.0}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
SMOKE_TEST="${SMOKE_TEST:-1}"
LOCAL="${PI_CODING_AGENT_LOCAL:-}"
# pi 配置模板默认取仓库内 pi-config/ 目录（未显式指定且目录不存在时静默跳过）
PI_CONFIG_DIR_EXPLICIT="${PI_CONFIG_DIR+set}"
PI_CONFIG_DIR="${PI_CONFIG_DIR:-$ROOT/pi-config}"

log() { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. 构建机前置检查
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "PATH 中没有 node（构建需要 Node >= 22，产物不需要）"
node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' \
  || die "构建机需要 Node >= 22（当前 $(node -v)）"
command -v tar >/dev/null 2>&1 || die "PATH 中没有 tar"

rm -rf "$WORK"
mkdir -p "$WORK" "$OUT_DIR"

# ---------------------------------------------------------------------------
# 1. 把仓库复制到一次性工作目录（保持源树干净：不动 node_modules/.next/.git）
# ---------------------------------------------------------------------------
log "复制源码到 $SRC（排除 node_modules/.next/.git/build/dist）"
mkdir -p "$SRC"
(cd "$ROOT" && tar --exclude='./node_modules' --exclude='./.next' --exclude='./.git' \
  --exclude='./build' --exclude='./dist' -cf - .) | (cd "$SRC" && tar -xf -)

# ---------------------------------------------------------------------------
# 2. 安装依赖（完整安装，next build 需要 devDependencies）
# ---------------------------------------------------------------------------
log "npm ci"
(cd "$SRC" && npm ci --no-audit --no-fund)

# ---------------------------------------------------------------------------
# 3.（可选）替换为本地编译的 pi-coding-agent
#    通过把依赖改成 file: 说明符再 npm install，package.json 与 lockfile 同步，
#    后续 prune/build 都不会把它回退成 registry 版本。
# ---------------------------------------------------------------------------
if [ -n "$LOCAL" ]; then
  case "$LOCAL" in
    http://*|https://*)
      SPEC="$LOCAL" ;;
    *)
      [ -e "$LOCAL" ] || die "PI_CODING_AGENT_LOCAL 不存在: $LOCAL"
      SPEC="file:$(cd "$(dirname "$LOCAL")" && pwd)/$(basename "$LOCAL")"
      ;;
  esac
  log "使用本地 pi-coding-agent: $LOCAL"
  (cd "$SRC" && npm pkg set "dependencies.@earendil-works/pi-coding-agent=$SPEC")
  (cd "$SRC" && npm install --no-audit --no-fund)
fi
(cd "$SRC" && node -e 'console.log("   pi-coding-agent ->", require("@earendil-works/pi-coding-agent/package.json").version)')

# ---------------------------------------------------------------------------
# 4. 生产构建
# ---------------------------------------------------------------------------
log "npm run build（next build --webpack）"
(cd "$SRC" && npm run build)

# ---------------------------------------------------------------------------
# 5. 只保留生产依赖
# ---------------------------------------------------------------------------
log "npm prune --omit=dev"
(cd "$SRC" && npm prune --omit=dev --no-audit --no-fund)
if [ -n "$LOCAL" ]; then
  # 把 shipped package.json 里的 file: 说明符还原成具体版本号，保持整洁
  LOCAL_VER="$(cd "$SRC" && node -p 'require("@earendil-works/pi-coding-agent/package.json").version')"
  (cd "$SRC" && npm pkg set "dependencies.@earendil-works/pi-coding-agent=$LOCAL_VER")
fi

# ---------------------------------------------------------------------------
# 6. 清理 .next 里的开发产物
# ---------------------------------------------------------------------------
log "清理 .next（dev 缓存与 source map）"
rm -rf "$SRC/.next/dev" "$SRC/.next/cache"
find "$SRC/.next" -name '*.map' -type f -delete

# ---------------------------------------------------------------------------
# 7. 组装包目录
# ---------------------------------------------------------------------------
PKG="$WORK/pi-linux-$ARCH"
rm -rf "$PKG"
mkdir -p "$PKG/app"
log "组装 $PKG"
cp -a "$SRC/bin" "$SRC/.next" "$SRC/public" "$SRC/next.config.ts" "$SRC/package.json" "$PKG/app/"
cp -a "$SRC/node_modules" "$PKG/app/"
VERSION="$(node -p "require('$SRC/package.json').version")"
echo "$VERSION" > "$PKG/VERSION.txt"
cp -a "$ROOT/packaging/." "$PKG/"
chmod +x "$PKG/pi" "$PKG/pi-web.sh" "$PKG/start.sh" "$PKG/open-pi-terminal.sh" \
  "$PKG/install-to-path.sh" "$PKG/install-pi-config.sh" "$PKG/update.sh"

# ---------------------------------------------------------------------------
# 7b. 打包 pi 配置模板（扩展/模型接口等配置的规范分发）
#     PI_CONFIG_DIR 指向一个 .pi 目录（或其 agent/ 子目录，自动识别），
#     打包成 config/pi/；目标机首次运行时由 install-pi-config.sh 合并到
#     ~/.pi/agent。打包时排除会话、凭证、托管二进制与临时文件。
# ---------------------------------------------------------------------------
if [ -d "$PI_CONFIG_DIR" ]; then
  if [ -d "$PI_CONFIG_DIR/agent" ]; then
    CFG_SRC="$PI_CONFIG_DIR/agent"     # 用户指向整个 ~/.pi
  else
    CFG_SRC="$PI_CONFIG_DIR"           # 用户指向 agent 目录本身
  fi
  [ -d "$CFG_SRC" ] || die "PI_CONFIG_DIR 中未找到配置目录: $CFG_SRC"
  log "打包 pi 配置模板: $CFG_SRC"
  mkdir -p "$PKG/config/pi"
  (cd "$CFG_SRC" && tar --exclude='./sessions' --exclude='./auth.json' \
    --exclude='./bin' --exclude='./tmp' --exclude='./pi-debug.log' \
    --exclude='./.bundle-version' --exclude='./.bundle-backup' --exclude='./.gitkeep' \
    -cf - .) | (cd "$PKG/config/pi" && tar -xf -)
  PI_CONFIG_VERSION="${PI_CONFIG_VERSION:-1}"
  echo "$PI_CONFIG_VERSION" > "$PKG/config/pi/.bundle-version"
  log "配置模板版本: $PI_CONFIG_VERSION"
elif [ -n "$PI_CONFIG_DIR_EXPLICIT" ] && [ -n "$PI_CONFIG_DIR" ] && [ ! -e "$PI_CONFIG_DIR" ]; then
  die "PI_CONFIG_DIR 不存在: $PI_CONFIG_DIR"
fi
if [ -n "${PI_UPDATE_BASE_URL:-}" ]; then
  mkdir -p "$PKG/config"
  printf '%s\n' "$PI_UPDATE_BASE_URL" > "$PKG/config/update-url.txt"
  log "更新源: $PI_UPDATE_BASE_URL"
fi

# ---------------------------------------------------------------------------
# 8. 内置 Node.js 运行时
#    优先级: NODE_RUNTIME_LOCAL（本地包/目录/URL）> SKIP_RUNTIME_DOWNLOAD 复用
#           已有 runtime/ > 从 nodejs.org 下载
# ---------------------------------------------------------------------------
if [ -n "${NODE_RUNTIME_LOCAL:-}" ]; then
  LOCAL_RT="$NODE_RUNTIME_LOCAL"
  case "$LOCAL_RT" in
    http://*|https://*)
      log "获取 Node 运行时 (URL): $LOCAL_RT"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$LOCAL_RT" -o "$WORK/node-local.tar.gz"
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$WORK/node-local.tar.gz" "$LOCAL_RT"
      else
        die "需要 curl 或 wget 来获取 Node 运行时"
      fi
      LOCAL_RT="$WORK/node-local.tar.gz"
      ;;
  esac

  if [ -d "$LOCAL_RT" ]; then
    # 目录: 已解压的 node-v*-linux-*/ 目录，或直接是 runtime/ 布局
    log "使用本地 Node 运行时目录: $LOCAL_RT"
    if [ -x "$LOCAL_RT/bin/node" ]; then
      RT_SRC="$LOCAL_RT"
    elif [ -x "$LOCAL_RT/runtime/bin/node" ]; then
      RT_SRC="$LOCAL_RT/runtime"
    else
      die "NODE_RUNTIME_LOCAL 目录中未找到 bin/node: $LOCAL_RT"
    fi
    rm -rf "$PKG/runtime"
    mkdir -p "$PKG/runtime"
    cp -a "$RT_SRC/." "$PKG/runtime/"
  else
    [ -f "$LOCAL_RT" ] || die "NODE_RUNTIME_LOCAL 不存在: $LOCAL_RT"
    log "使用本地 Node 运行时包: $LOCAL_RT"
    case "$LOCAL_RT" in
      *.tar.xz) tar -xJf "$LOCAL_RT" -C "$WORK" ;;
      *)        tar -xzf "$LOCAL_RT" -C "$WORK" ;;
    esac
    # 找到解压结果中的 bin/node（兼容 node-v*-linux-*/ 或任意自定义布局）
    RT_BIN="$(find "$WORK" -maxdepth 4 -path '*/bin/node' -type f 2>/dev/null | head -n 1)"
    [ -n "$RT_BIN" ] || die "本地 Node 包解压后未找到 bin/node: $LOCAL_RT"
    rm -rf "$PKG/runtime"
    mkdir -p "$PKG/runtime"
    cp -a "$(dirname "$(dirname "$RT_BIN")")/." "$PKG/runtime/"
  fi
elif [ "${SKIP_RUNTIME_DOWNLOAD:-0}" = "1" ] && [ -d "$PKG/runtime" ]; then
  log "复用已有 runtime/（$("$PKG/runtime/bin/node" -v 2>/dev/null || echo '未知版本')）"
else
  URL="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.gz"
  log "下载 Node $NODE_VERSION ($ARCH): $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$WORK/node.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$WORK/node.tar.gz" "$URL"
  else
    die "需要 curl 或 wget 来下载 Node 运行时"
  fi
  tar -xzf "$WORK/node.tar.gz" -C "$WORK"
  rm -rf "$PKG/runtime"
  mkdir -p "$PKG/runtime"
  cp -a "$WORK/node-v$NODE_VERSION-linux-$ARCH/." "$PKG/runtime/"
fi

# 版本核对（无法在本机执行时跳过，例如交叉架构构建）
if [ -x "$PKG/runtime/bin/node" ] && RT_VER="$("$PKG/runtime/bin/node" -v 2>/dev/null)"; then
  log "内置 Node 版本: $RT_VER"
  RT_MAJOR="${RT_VER#v}"
  RT_MAJOR="${RT_MAJOR%%.*}"
  if [ "${RT_MAJOR:-0}" -lt 22 ] 2>/dev/null; then
    log "警告: pi-web 要求 Node >= 22.19.0，当前内置 $RT_VER"
  fi
fi

# ---------------------------------------------------------------------------
# 9. 冒烟测试（产物必须能启动）
# ---------------------------------------------------------------------------
if [ "$SMOKE_TEST" != "0" ]; then
  log "冒烟测试"
  # 用隔离的 HOME 运行，避免 pi / pi-web（含配置模板合并）写构建机的真实 ~/.pi
  SMOKE_HOME="$WORK/smoke-home"
  mkdir -p "$SMOKE_HOME"
  if ! "$PKG/runtime/bin/node" -e 'process.exit(0)' >/dev/null 2>&1; then
    echo "   内置 Node 无法在本机执行（交叉架构构建？），自动跳过冒烟测试"
    echo "   （如确需冒烟测试，请在目标架构的机器上构建，或显式设置 SMOKE_TEST=0）"
    SMOKE_TEST=0
  fi
fi
if [ "$SMOKE_TEST" != "0" ]; then
  "$PKG/runtime/bin/node" -v

  # pi CLI：TUI 需要 PTY，用 script 给它一个伪终端，验证进程能存活而不是立刻崩掉
  rm -f "$WORK/pi.log" "$WORK/pi.pid"
  if command -v script >/dev/null 2>&1; then
    PI_Q="$(printf '%q ' "$PKG/pi")"
    ( HOME="$SMOKE_HOME" script -qec "$PI_Q" /dev/null >"$WORK/pi.log" 2>&1 & echo $! >"$WORK/pi.pid" )
  else
    ( HOME="$SMOKE_HOME" "$PKG/pi" </dev/null >"$WORK/pi.log" 2>&1 & echo $! >"$WORK/pi.pid" )
  fi
  sleep 8
  if kill -0 "$(cat "$WORK/pi.pid")" 2>/dev/null; then
    echo "   pi CLI: OK（保持存活）"
    kill "$(cat "$WORK/pi.pid")" 2>/dev/null || true
  else
    echo "   pi CLI: 启动失败，日志如下："
    sed 's/^/     /' "$WORK/pi.log" | tail -n 20
    exit 1
  fi

  # pi-web：必须能应答 HTTP
  rm -f "$WORK/piweb.log" "$WORK/piweb.pid"
  ( HOME="$SMOKE_HOME" "$PKG/pi-web.sh" --no-open -p 31099 >"$WORK/piweb.log" 2>&1 & echo $! >"$WORK/piweb.pid" )
  WEB_OK=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null http://127.0.0.1:31099 2>/dev/null; then WEB_OK=1; break; fi
    sleep 1
  done
  kill "$(cat "$WORK/piweb.pid")" 2>/dev/null || true
  pkill -f "next start.*31099" 2>/dev/null || true
  if [ "$WEB_OK" = "1" ]; then
    echo "   pi-web: OK（http://127.0.0.1:31099 正常应答）"
  else
    echo "   pi-web: 启动失败，日志如下："
    sed 's/^/     /' "$WORK/piweb.log" | tail -n 30
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 10. 打包
# ---------------------------------------------------------------------------
OUT="$OUT_DIR/pi-linux-$ARCH-$VERSION.tar.gz"
log "打包 $OUT"
(cd "$WORK" && tar -czf "$OUT" "pi-linux-$ARCH")
(cd "$OUT_DIR" && sha256sum "pi-linux-$ARCH-$VERSION.tar.gz" > SHA256SUMS)
log "完成，产物："
ls -lh "$OUT" "$OUT_DIR/SHA256SUMS"
echo
echo "  将 pi-linux-$ARCH/ 拷到目标 Linux 机器后："
echo "    ./start.sh    菜单入口"
echo "    ./pi          启动 CLI Agent（用法同官方 pi 命令）"
echo "    ./pi-web.sh   启动 WebUI（浏览器访问 http://127.0.0.1:30141）"
if [ -d "$PKG/config/pi" ]; then
  echo "    ./update.sh  检查并更新（首次运行时配置模板已自动合并到 ~/.pi/agent）"
fi
