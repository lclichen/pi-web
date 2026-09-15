#!/usr/bin/env bash
#
# package-electron.sh — 构建 amedac.ai 桌面版（Electron）分发包。
#
# 产物:
#   dist/amedac.ai-electron-<arch>-<version>.zip  (+ .sha256)
#   build/package-electron/amedac-electron-<arch>/ 原始目录（可直接运行 ./electron）
#
# 结构:
#   amedac-electron-<arch>/
#     electron 等运行文件（官方 prebuilt zip 解包）
#     resources/app/{main.js, preload.js, package.json}
#     resources/app/bundle/          ← package-linux.sh 产物（pkg-kind=electron）
#
# 环境变量:
#   ELECTRON_VERSION    Electron 版本（默认 36.4.0）
#   ELECTRON_MIRROR     下载镜像（默认淘宝 npmmirror，适配国内网络；
#                       官方源用 https://github.com/electron/electron/releases/download）
#   ELECTRON_LOCAL      本地 electron zip（离线构建机；设置后不下载）
#   SKIP_LINUX_PACKAGE=1  复用已有 package-linux 产物不重建
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT"
WORK="$ROOT/build/package-electron"
DIST="$ROOT/dist"
ARCH="${ELECTRON_ARCH:-$(uname -m | sed 's/^x86_64$/x64/;s/^aarch64$/arm64/')}"
ELECTRON_VERSION="${ELECTRON_VERSION:-36.4.0}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron}"
OUT="$WORK/amedac-electron-$ARCH"
APP_VERSION="$(node -p "require('$SRC/version.json').version" 2>/dev/null || node -p "require('$SRC/package.json').version")"

log() { echo "   $*"; }
die() { echo "   错误: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "PATH 中没有 node"
command -v unzip >/dev/null 2>&1 || die "需要 unzip"

# 1. 基础服务包（复用 package-linux.sh 产物）
PKG_SRC="$ROOT/build/package-linux/amedac.ai-pi-linux-$ARCH"
if [ "$SKIP_LINUX_PACKAGE" != "1" ] || [ ! -d "$PKG_SRC/scripts" ]; then
  log "构建基础 Linux 包（package-linux.sh）…"
  (cd "$ROOT" && bash scripts/package-linux.sh)
fi
[ -d "$PKG_SRC/scripts" ] || die "未找到基础包 $PKG_SRC"

# 2. Electron 运行时
mkdir -p "$WORK" "$DIST"
ELECTRON_ZIP="electron-v$ELECTRON_VERSION-linux-$ARCH.zip"
ELECTRON_CACHE="$WORK/$ELECTRON_ZIP"
if [ -n "${ELECTRON_LOCAL:-}" ]; then
  [ -f "$ELECTRON_LOCAL" ] || die "ELECTRON_LOCAL 不存在: $ELECTRON_LOCAL"
  ELECTRON_CACHE="$ELECTRON_LOCAL"
elif [ ! -f "$ELECTRON_CACHE" ]; then
  log "下载 Electron $ELECTRON_VERSION ($ARCH)…"
  curl -fL --retry 3 -o "$ELECTRON_CACHE" "$ELECTRON_MIRROR/$ELECTRON_VERSION/$ELECTRON_ZIP" \
    || die "下载失败（离线机器用 ELECTRON_LOCAL 指定本地 zip）"
fi

# 3. 组装
rm -rf "$OUT"
mkdir -p "$OUT"
unzip -q "$ELECTRON_CACHE" -d "$OUT"
[ -x "$OUT/electron" ] || die "Electron zip 解包后缺少 electron 可执行文件"

mkdir -p "$OUT/resources/app"
cp -a "$SRC/electron/main.js" "$SRC/electron/preload.js" "$OUT/resources/app/"
cat > "$OUT/resources/app/package.json" <<EOF
{
  "name": "amedac-electron",
  "version": "$APP_VERSION",
  "main": "main.js"
}
EOF

cp -a "$PKG_SRC" "$OUT/resources/app/bundle"
rm -rf "$OUT/resources/app/bundle/run" \
       "$OUT/resources/app/bundle/logs" \
       "$OUT/resources/app/bundle/data"
# 桌面版自更新 = 交换 bundle 目录后由 applier 重启 electron 二进制。
echo electron > "$OUT/resources/app/bundle/pkg-kind"
# 默认不带走 chrome-sandbox 的 setuid 依赖：无沙箱场景由 main 侧 --no-sandbox 兜底
# （更新器重启 electron 时同样带 --no-sandbox）。
chmod +x "$OUT/electron" 2>/dev/null || true

# 4. 压缩产物
OUT_ZIP="$DIST/amedac.ai-electron-$ARCH-$APP_VERSION.zip"
log "压缩 → $OUT_ZIP"
(cd "$WORK" && zip -qr "$OUT_ZIP" "amedac-electron-$ARCH")
( cd "$DIST" && sha256sum "amedac.ai-electron-$ARCH-$APP_VERSION.zip" > "amedac.ai-electron-$ARCH-$APP_VERSION.zip.sha256" )

# 5. 冒烟（有 xvfb 时做真启动检查；无则提示手动）
if command -v xvfb-run >/dev/null 2>&1 && [ "${ELECTRON_SMOKE:-1}" = "1" ]; then
  log "冒烟：xvfb 下启动 electron（--version 级）…"
  xvfb-run -a "$OUT/electron" --version >/dev/null 2>&1 || die "electron 无法启动"
  log "冒烟: OK"
else
  log "提示：无 xvfb-run，跳过图形冒烟（目标机首次启动自会验证）"
fi

echo
echo "   Electron 桌面包: $OUT_ZIP"
echo "   运行目录:         $OUT（./electron 启动）"
