#!/usr/bin/env bash
#
# package-appimage.sh — 在 package-linux.sh 产物之上构建 amedac.ai AppImage。
#
#   dist/amedac.ai-<arch>.AppImage   (+ SHA256SUMS)
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
#   APP_ICON_SVG           自有平台 logo（矢量），装进 hicolor/scalable
#   APP_ICON_PNG           自有 logo 位图（建议 ≥256×256），替换占位图标
#   VERSION / ARCH / OUT_DIR / SMOKE_TEST  同 package-linux.sh
#
# 目标机要求: Linux x64/arm64；直接执行需 FUSE(fuse2/3)，无 FUSE 时用
#   ./amedac.ai-x86_64.AppImage --appimage-extract-and-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${ARCH:-x64}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
WORK="$ROOT/build/package-appimage"
SKIP_LINUX_PACKAGE="${SKIP_LINUX_PACKAGE:-0}"

log() { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
BUILD_START=$SECONDS
fmt_dur() { local t=$1; printf '%dm%02ds' $((t / 60)) $((t % 60)); }

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
APPDIR="$WORK/amedac.ai"
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

# ---- 图标 -----------------------------------------------------------------
# 默认用 gen-icon.mjs 现生成的占位图标；提供了自己的 logo 时优先使用：
#   APP_ICON_SVG=/path/logo.svg   矢量图标，装进 hicolor/scalable（缩放最佳）
#   APP_ICON_PNG=/path/logo.png   位图图标（建议 ≥256×256），替换 256 槽位
ICON_PNG="$APPDIR/usr/share/icons/hicolor/256x256/apps/amedac.png"
if [ -n "${APP_ICON_PNG:-}" ]; then
  [ -f "$APP_ICON_PNG" ] || die "APP_ICON_PNG 不存在: $APP_ICON_PNG"
  cp -f "$APP_ICON_PNG" "$ICON_PNG"
  log "使用自定义 PNG 图标: $APP_ICON_PNG"
else
  node "$ROOT/packaging/gen-icon.mjs" 256 "$ICON_PNG"
fi
if [ -n "${APP_ICON_SVG:-}" ]; then
  [ -f "$APP_ICON_SVG" ] || die "APP_ICON_SVG 不存在: $APP_ICON_SVG"
  mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"
  cp -f "$APP_ICON_SVG" "$APPDIR/usr/share/icons/hicolor/scalable/apps/amedac.svg"
  log "使用自定义 SVG 图标: $APP_ICON_SVG"
fi
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
OUT_NAME="amedac.ai-$ARCH.AppImage"
OUT="$OUT_DIR/$OUT_NAME"
mkdir -p "$OUT_DIR"
log "生成 $OUT"
# 注：不带 --update-information（zsync 自更新对这种“首启即展开”的分发方式
# 意义不大，且部分 continuous 版工具不认该参数）；升级靠重新下发新 AppImage。

# type2 runtime：优先用缓存的本地文件（构建机网络不稳时常下载失败），
# 缺失时让 appimagetool 自行下载。手动更新缓存:
#   curl -L -o build/tools/runtime-$TOOL_ARCH \
#     https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-$TOOL_ARCH
RUNTIME_FILE="$TOOLS/runtime-$TOOL_ARCH"
TOOL_ARGS=(--comp zstd)
if [ ! -s "$RUNTIME_FILE" ]; then
  log "缓存 type2 runtime ($TOOL_ARCH) …"
  URLS=(
    "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-$TOOL_ARCH"
    "https://mirror.ghproxy.com/https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-$TOOL_ARCH"
  )
  for u in "${URLS[@]}"; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 --connect-timeout 15 "$u" -o "$RUNTIME_FILE.downloading" && mv "$RUNTIME_FILE.downloading" "$RUNTIME_FILE" && break
    else
      wget -q -O "$RUNTIME_FILE.downloading" "$u" && mv "$RUNTIME_FILE.downloading" "$RUNTIME_FILE" && break
    fi
  done
fi
# runtime 是 ELF，AppImage 魔数 AI\x02 在偏移 8 处
if [ -s "$RUNTIME_FILE" ] && [ "$(dd if="$RUNTIME_FILE" bs=1 skip=8 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "41490200" ]; then
  TOOL_ARGS+=(--runtime-file "$RUNTIME_FILE")
else
  rm -f "$RUNTIME_FILE"
  log "未取得本地 runtime 缓存，交由 appimagetool 下载"
fi

VERSION="$VERSION" run_tool "${TOOL_ARGS[@]}" "$APPDIR" "$OUT"

# 镜像已生成；立即释放 ≈1GB 的 AppDir 暂存（后续冒烟可能很吃磁盘）。
# 要调试包内容时 AMEDAC_KEEP_STAGING=1。
if [ "${AMEDAC_KEEP_STAGING:-0}" != "1" ]; then
  rm -rf "$APPDIR"
  log "已清理 AppDir 暂存（AMEDAC_KEEP_STAGING=1 可保留）"
fi

# ---------------------------------------------------------------------------
# 4. 冒烟
#    ①零开销：--appimage-offset 能读出 squashfs 偏移 = ELF/魔数/嵌入完整；
#    ②完整：--appimage-extract-and-run 真跑一次 stop 子命令（需约 3GB 余量，
#      自解压 + AppRun 首启展开各占一份）。磁盘紧张时跳过②。
# ---------------------------------------------------------------------------
if [ "${SMOKE_TEST:-1}" != "1" ]; then
  log "冒烟测试已跳过（SMOKE_TEST=0）"
else
  OUT_ABS="$(cd "$OUT_DIR" && pwd)/$OUT_NAME"
  OFFSET="$("$OUT_ABS" --appimage-offset 2>/dev/null || true)"
  case "$OFFSET" in
    ''|*[!0-9]*) die "AppImage 完整性校验失败（--appimage-offset 无输出）" ;;
    *) echo "   AppImage 结构校验: OK（squashfs offset=${OFFSET}B）" ;;
  esac

  AVAIL_KB="$(df -Pk "$(dirname "$OUT")" | awk 'NR==2{print $4}')"
  if [ "${AVAIL_KB:-0}" -lt 3000000 ]; then
    log "磁盘可用不足 3GB，跳过自解压运行冒烟（目标机首启时自会验证）"
  else
    log "冒烟测试（AppImage 自解压模式）…"
    THOME="$WORK/smoke-home"
    rm -rf "$THOME"; mkdir -p "$THOME/home"
    if ( cd "$THOME" \
         && AMEDAC_HOME="$THOME/home" HOME="$THOME/home" PLATFORM_PORT=31190 WEB_PORT=31191 \
            "$OUT_ABS" --appimage-extract-and-run stop >/dev/null 2>&1; \
         [ -d "$THOME/home/app/scripts" ] ); then
      echo "   AppImage: OK（可运行、能展开、子命令可用）"
    else
      echo "   AppImage: 自解压冒烟失败"
      exit 1
    fi
    rm -rf "$THOME"
  fi
fi

BUILD_TAKEN=$((SECONDS - BUILD_START))
log "完成（用时 $(fmt_dur "$BUILD_TAKEN")），产物："
printf '  %10s  %s\n' "$(du -h "$OUT" | cut -f1)" "$OUT"
(cd "$OUT_DIR" && sha256sum "$OUT_NAME" > SHA256SUMS)
echo
echo "  使用方式（目标 Linux 机，双击或命令行均可）:"
echo "    ./amedac.ai-$ARCH.AppImage           启动服务并打开浏览器（幂等）"
echo "    ./amedac.ai-$ARCH.AppImage status    服务状态"
echo "    ./amedac.ai-$ARCH.AppImage stop      停止全部"
echo "    ./amedac.ai-$ARCH.AppImage logs      日志位置提示"
echo "  无 FUSE 的机器: ./amedac.ai-$ARCH.AppImage --appimage-extract-and-run"
echo "  数据/配置位置: \${XDG_DATA_HOME:-~/.local/share}/amedac/{data,app/sandbox/*.env}"
