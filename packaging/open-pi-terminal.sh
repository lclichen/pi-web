#!/usr/bin/env bash
#
# open-pi-terminal.sh — 桌面环境下双击运行：自动探测终端模拟器，
# 开一个窗口进入 pi CLI Agent（TUI 需要真实终端）。
#
# 可用环境变量 TERMINAL 指定你偏好的终端程序，例如:
#   TERMINAL=kitty ./open-pi-terminal.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_CMD=("$DIR/pi")

if [ -n "${TERMINAL:-}" ] && command -v "$TERMINAL" >/dev/null 2>&1; then
  exec "$TERMINAL" -e "${PI_CMD[@]}"
fi

for t in gnome-terminal konsole xfce4-terminal x-terminal-emulator xterm alacritty kitty urxvt; do
  command -v "$t" >/dev/null 2>&1 || continue
  case "$t" in
    gnome-terminal) exec "$t" -- "${PI_CMD[@]}" ;;
    *)              exec "$t" -e "${PI_CMD[@]}" ;;
  esac
done

echo "未找到可用的终端模拟器。请手动打开一个终端并运行: ./pi"
exit 1
