#!/usr/bin/env bash
#
# start.sh — 离线分发包的菜单入口。
# 终端里运行 ./start.sh，或用文件管理器双击（多数桌面环境会用终端打开）。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$DIR/VERSION.txt" 2>/dev/null || echo 'unknown')"
ARCH="$(uname -m)"

press_enter() {
  printf "  按回车返回菜单..."
  read -r _ || true
}

menu() {
  clear 2>/dev/null || true
  echo "=============================================="
  echo "  pi + pi-web 离线包   v$VERSION  ($ARCH)"
  echo "=============================================="
  echo
  echo "  1) 启动 WebUI（浏览器打开 http://127.0.0.1:30141）"
  echo "  2) 启动 CLI Agent（pi，在终端里直接交互）"
  echo "  3) 安装到 PATH（之后任意目录可敲 pi / pi-web）"
  echo "  4) 查看使用说明"
  echo "  5) 检查更新（./update.sh，需要能访问更新源）"
  echo "  q) 退出"
  echo
  printf "  请选择: "
}

while true; do
  menu
  read -r choice
  case "$choice" in
    1) "$DIR/pi-web.sh"; echo; echo "WebUI 已退出。"; press_enter ;;
    2) "$DIR/pi"; echo; echo "CLI 已退出。"; press_enter ;;
    3) bash "$DIR/install-to-path.sh"; press_enter ;;
    4) cat "$DIR/README.txt" 2>/dev/null || echo "（README.txt 不存在）"; press_enter ;;
    5) bash "$DIR/update.sh"; echo; press_enter ;;
    q|Q|exit) echo "再见。"; exit 0 ;;
    *) echo "无效选择。"; sleep 1 ;;
  esac
done
