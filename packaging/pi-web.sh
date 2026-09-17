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

# 可写数据目录收敛到每用户 $AMEDAC_HOME（v3 起与 start-all / AppImage
# 一致；显式 PI_WEB_DATA_DIR 优先）。旧独立部署曾回落写到 <包>/app/data
# （cwd/data），首次启动时一次性迁移（幂等）。
if [ -f "$DIR/scripts/amedac-home.sh" ]; then
  # 打包布局：helper 位于 <包>/scripts/
  # shellcheck source=scripts/amedac-home.sh
  source "$DIR/scripts/amedac-home.sh"
elif [ -f "$DIR/amedac-home.sh" ]; then
  # 仓库布局：helper 与本脚本同在 packaging/
  # shellcheck source=amedac-home.sh
  source "$DIR/amedac-home.sh"
fi
if declare -F amedac_resolve_dirs >/dev/null 2>&1; then
  amedac_resolve_dirs
  amedac_migrate_pkg_dirs "$DIR"
  export PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-$DATA_DIR/piweb}"
fi

# agent 会话空闲关闭时长：代码默认 10 分钟对整日使用的工作会话太激进，
# 部署默认放宽为 7 天（0=禁用；显式设置优先）。会话文件始终保留，
# 空闲关闭只是释放运行时资源，重新打开会话可完整恢复。
export PI_WEB_IDLE_TIMEOUT_MS="${PI_WEB_IDLE_TIMEOUT_MS:-604800000}"

exec "$DIR/runtime/bin/node" "$DIR/app/bin/pi-web.js" "$@"
