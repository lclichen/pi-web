#!/usr/bin/env bash
#
# package-appimage.sh — 在 package-linux.sh 产物之上构建 Amedac.ai AppImage。
#
#   dist/Amedac.ai-<arch>.AppImage   (+ SHA256SUMS)
#
# 双击/命令行一键启动：首次运行把分发包展开到 ~/.local/share/amedac/app，
# 数据与配置在 ../data 与升级时自动还原的 sandbox/*.env（见 AppRun）。
#
# 用法:
#   bash scripts/package-appimage.sh              # 复用/重建 linux 包再打包
#
# 环境变量（全部可选）:
#   SKIP_LINUX_PACKAGE=1   直接复用 build/package-linux/ 现有产物
#   APPIMAGETOOL           appimagetool 路径（默认下载到 build/tools/ 缓存）
#   VERSION / ARCH / OUT_DIR / SMOKE_TEST  同 package-linux.sh
#
# 目标机要求: Linux x64/arm64；直接执行需 FUSE(fuse2/3)，无 FUSE 时用
#   ./Amedac.ai-x86_64.AppImage --appimage-extract-and-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${ARCH:-x64}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
WORK="$ROOT/build/package-appimage"
SKIP_LINUX_PACKAGE="${SKIP_LINUX_PACKAGE:-0}"

log() { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "PATH 中没有 node"
command -v bash >/dev/null 2>&1 || die "需要 bash"

PKG_SRC="$ROOT/build/package-linux/amedac.ai-pi-linux-$ARCH"
if [ "$SKIP_LINUX_PACKAGE" != "1" ] || [ ! -d "$PKG_SRC/scripts" ]; then
  log "构建基础 Linux 包（package-linux.sh）…"
  (cd "$ROOT" && bash scripts/package-linux.sh)
fi
[ -d "$PKG_SRC/scripts" ] || die "未找到基础包 $PKG_SRC —— 先成功运行 package-linux.sh"

VERSION="$(node -p "require('$ROOT/package.json').version")"

# ---------------------------------------------------------------------------
# 1. 组装 AppDir
#    AppDir/
#    ├── AppRun                 （启动器：展开 + start-all + 开浏览器）
#    ├── amedac.ai.desktop
#    ├── .DirIcon -> usr/share/icons/hicolor/256x256/apps/amedac.png
#    └── usr/share/amedac/      ← 整个 linux 分发包内容
# ---------------------------------------------------------------------------
APPDIR="$WORK/Amedac.ai"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/share" "$APPDIR/usr/share/icons/hicolor/256x256/apps"
log "组装 $APPDIR"
cp -a "$PKG_SRC" "$APPDIR/usr/share/amedac"
rm -rf "$APPDIR/usr/share/amedac/run" \
       "$APPDIR/usr/share/amedac/logs" \
       "$APPDIR/usr/share/amedac/data"          # 打包机残留的运行数据不进镜像

cp -a "$ROOT/packaging/appimage/AppRun" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp -a "$ROOT/packaging/appimage/amedac.ai.desktop" "$APPDIR/amedac.ai.desktop"

node "$ROOT/packaging/gen-icon.mjs" 256 "$APPDIR/usr/share/icons/hicolor/256x256/apps/amedac.png"
ln -sfn "usr/share/icons/hicolor/256x256/apps/amedac.png" "$APPDIR/.DirIcon"
# appimagetool 按 desktop 的 Icon=<名字> 在 AppDir 根 / usr/share/pixmaps 找同名图标
ln -sfn "usr/share/icons/hicolor/256x256/apps/amedac.png" "$APPDIR/amedac.png"
mkdir -p "$APPDIR/usr/share/pixmaps"
ln -sfn "../icons/hicolor/256x256/apps/amedac.png" "$APPDIR/usr/share/pixmaps/amedac.png"

# desktop 里 Exec 用 %u 占位；appimagetool 会把它改成绝对路径引用

# ---------------------------------------------------------------------------
# 2. appimagetool（官方工具；自带 mksquashfs，无需系统安装）
# ---------------------------------------------------------------------------
TOOLS="$ROOT/build/tools"
mkdir -p "$TOOLS"
TOOL="$TOOLS/appimagetool-$ARCH.AppImage"
case "$ARCH" in
  x86_64|x64) TOOL_ARCH="x86_64" ;;
  aarch64|arm64) TOOL_ARCH="aarch64" ;;
  *) die "不支持的架构: $ARCH" ;;
esac
if [ ! -x "${APPIMAGETOOL:-}" ]; then
  if [ ! -f "$TOOL" ]; then
    URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$TOOL_ARCH.AppImage"
    log "下载 appimagetool ($TOOL_ARCH) …"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$URL" -o "$TOOL.downloading"
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$TOOL.downloading" "$URL"
    else
      die "需要 curl 或 wget 下载 appimagetool（或用 APPIMAGETOOL= 指定本地工具）"
    fi
    mv "$TOOL.downloading" "$TOOL"
    chmod +x "$TOOL"
  fi
  APPIMAGETOOL="$TOOL"
fi
[ -x "$APPIMAGETOOL" ] || die "appimagetool 不可执行: $APPIMAGETOOL"

run_tool() {
  # 包内同时存在多种架构的 elf（node 预编译模块等）会让自动探测失败，
  # 显式指定目标架构；无 FUSE 的构建机用自解压模式跑工具本身。
  if "$APPIMAGETOOL" --version >/dev/null 2>&1; then
    ARCH="$TOOL_ARCH" "$APPIMAGETOOL" "$@"
  else
    log "构建机缺 FUSE，使用 --appimage-extract-and-run 运行 appimagetool"
    ARCH="$TOOL_ARCH" "$APPIMAGETOOL" --appimage-extract-and-run "$@"
  fi
}

# ---------------------------------------------------------------------------
# 3. 生成 AppImage
# ---------------------------------------------------------------------------
OUT_NAME="Amedac.ai-$ARCH.AppImage"
OUT="$OUT_DIR/$OUT_NAME"
mkdir -p "$OUT_DIR"
log "生成 $OUT"
# 注：不带 --update-information（zsync 自更新对这种“首启即展开”的分发方式
# 意义不大，且部分 continuous 版工具不认该参数）；升级靠重新下发新 AppImage。
VERSION="$VERSION" run_tool --comp zstd "$APPDIR" "$OUT"

# 冒烟：--appimage-extract-and-run 应能展开分发包（status 可走通）
if command -v curl >/dev/null 2>&1 && [ "${SMOKE_TEST:-1}" = "1" ]; then
  log "冒烟测试（AppImage 自解压模式，AMEDAC_HOME 指向临时目录）…"
  THOME="$WORK/smoke-home"
  rm -rf "$THOME"; mkdir -p "$THOME/home"
  OUT_ABS="$(cd "$OUT_DIR" && pwd)/$OUT_NAME"
  if ( cd "$THOME" \
       && AMEDAC_HOME="$THOME/home" HOME="$THOME/home" PLATFORM_PORT=31190 WEB_PORT=31191 \
          "$OUT_ABS" --appimage-extract-and-run stop >/dev/null 2>&1; \
       [ -d "$THOME/home/app/scripts" ] ); then
    echo "   AppImage: OK（可运行、能展开、子命令可用）"
    rm -rf "$THOME"
  else
    echo "   AppImage: 自解压冒烟失败"
    exit 1
  fi
fi

log "完成:"
ls -lh "$OUT"
(cd "$OUT_DIR" && sha256sum "$OUT_NAME" > SHA256SUMS)
echo
echo "  使用方式（目标 Linux 机，双击或命令行均可）:"
echo "    ./Amedac.ai-$ARCH.AppImage           启动服务并打开浏览器（幂等）"
echo "    ./Amedac.ai-$ARCH.AppImage status    服务状态"
echo "    ./Amedac.ai-$ARCH.AppImage stop      停止全部"
echo "    ./Amedac.ai-$ARCH.AppImage logs      日志位置提示"
echo "  无 FUSE 的机器: ./Amedac.ai-$ARCH.AppImage --appimage-extract-and-run"
echo "  数据/配置位置: \${XDG_DATA_HOME:-~/.local/share}/amedac/{data,app/sandbox/*.env}"
