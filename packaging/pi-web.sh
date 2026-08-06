#!/usr/bin/env bash
#
# pi-web.sh — pi-web WebUI 启动器（离线分发包内嵌版）。
# 参数与官方 pi-web 一致，例如:
#   ./pi-web.sh                          # 默认 127.0.0.1:30141，自动开浏览器
#   ./pi-web.sh --port 8080 --no-open
#   PI_WEB_PASSWORD='长密码' ./pi-web.sh # 启用 Basic Auth（用户名 pi）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/runtime/bin/node" "$DIR/app/bin/pi-web.js" "$@"
