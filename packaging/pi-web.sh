#!/usr/bin/env bash
#
# pi-web.sh — pi-web WebUI 启动器（离线分发包内嵌版）。
# 参数与官方 pi-web 一致，例如:
#   ./pi-web.sh                          # 默认 127.0.0.1:30141，自动开浏览器
#   ./pi-web.sh --port 8080 --no-open
#   PI_WEB_PASSWORD='长密码' ./pi-web.sh # 启用 Basic Auth（用户名 pi）
set -euo pipefail

# 解析脚本真实路径（支持通过软链调用，如 install-to-path.sh 装的
# ~/.local/bin/pi-web -> <包目录>/pi-web.sh）
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  TARGET="$(readlink "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *)  SOURCE="$(dirname "$SOURCE")/$TARGET" ;;
  esac
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

# 包内附带的 CLI 工具（fd / rg 等，打包时用 PI_BINARIES 拷入 bin/）加入 PATH
if [ -d "$DIR/bin" ]; then
  export PATH="$DIR/bin:$PATH"
fi

# 首次运行/配置模板升级时，自动把包内 config/pi/ 合并到 ~/.pi/agent
# （幂等：无事可做时立即静默返回；失败不阻塞启动）
# 软链模式包根仅在未被设置时取本包目录：AppImage 下 AppRun 已把
# PI_CONFIG_LINK_ROOT 指向本次挂载点（每次启动都不同，软链由脚本每次
# 刷新），绝不能在这里覆盖，否则扩展软链会指向已卸载的临时目录。
# AMEDAC_PKG_MODE=copy 可切换为真实拷贝模式（与包位置解耦）。
if [ -x "$DIR/scripts/install-pi-config.sh" ]; then
  export PI_CONFIG_LINK_ROOT="${PI_CONFIG_LINK_ROOT:-$DIR}"
  "$DIR/scripts/install-pi-config.sh" || true
fi

exec "$DIR/runtime/bin/node" "$DIR/app/bin/pi-web.js" "$@"
