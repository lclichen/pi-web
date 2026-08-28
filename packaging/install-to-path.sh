#!/usr/bin/env bash
#
# install-to-path.sh — 把 pi / pi-web 软链到 ~/.local/bin，之后任意目录可直接敲命令。
#
# 用法:
#   ./install-to-path.sh                          # 安装到 ~/.local/bin
#   INSTALL_DIR=/usr/local/bin sudo ./install-to-path.sh   # 系统级安装
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 本脚本位于包内 scripts/ 子目录，包根为上一级
ROOT="$(dirname "$DIR")"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

mkdir -p "$INSTALL_DIR"
ln -sf "$ROOT/pi"        "$INSTALL_DIR/pi"
if [ -e "$ROOT/pi-web" ]; then ln -sf "$ROOT/pi-web" "$INSTALL_DIR/pi-web"; else ln -sf "$ROOT/pi-web.sh" "$INSTALL_DIR/pi-web"; fi

echo "已安装:"
echo "  $INSTALL_DIR/pi      -> $ROOT/pi"
echo "  $INSTALL_DIR/pi-web  -> $ROOT/pi-web"
echo
echo "请确认 $INSTALL_DIR 在 PATH 中（通常 ~/.local/bin 默认就在）。"
echo "卸载: 删除上面两个软链即可，离线包目录本身可随时删除。"
