#!/usr/bin/env bash
#
# upgrade-bundle.sh — tar.gz 目录部署的安全原地升级。
#
#   ./scripts/upgrade-bundle.sh /path/to/amedac.ai-pi-linux-x64-<新版本>.tar.gz
#
# 做什么：
#   1. 停止当前服务（保留数据）
#   2. 解压新版本包覆盖应用代码——但排除所有用户内容：
#        config/（platform.env、piweb.env、admin-password.txt）
#        data/（数据库、overlay、工作区）
#        run/ logs/ .v1 备份
#   3. 旧版布局（配置在 sandbox/）自动搬迁到 config/
#   4. 重新启动服务（数据库 schema 由平台幂等迁移自动升级）
#
# 与数据相关的所有内容都不会被触碰；升级失败可整目录回滚（见最后提示）。
set -euo pipefail

if [ $# -lt 1 ] || [ ! -f "$1" ]; then
  echo "用法: $0 <新版本 tar.gz 路径>" >&2
  exit 1
fi
TARBALL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  T="$(readlink "$SOURCE")"
  case "$T" in /*) SOURCE="$T" ;; *) SOURCE="$(dirname "$SOURCE")/$T" ;; esac
done
SCRIPTS="$(cd "$(dirname "$SOURCE")" && pwd)"
PKG="$(cd "$SCRIPTS/.." && pwd)"

CONFIG_DIR="${AMEDAC_CONFIG_DIR:-$PKG/config}"
RUN_DIR="${AMEDAC_RUN_DIR:-$PKG/run}"
LOG_DIR="${AMEDAC_LOG_DIR:-$PKG/logs}"
BACKUP="$PKG/.upgrade-backup-$(date +%Y%m%d-%H%M%S)"

log() { printf '\033[1;32m>>\033[0m %s\n' "$*"; }

# 1. 停服
bash "$SCRIPTS/stop-all.sh" || true

# 2. 升级前把现有用户内容快照到备份目录（双保险：tar 排除之外的第二层保障）
log "备份用户内容 → $BACKUP"
mkdir -p "$BACKUP"
for d in config data; do
  [ -d "$PKG/$d" ] && cp -a "$PKG/$d" "$BACKUP/$d"
done
[ -d "$PKG/sandbox" ] && cp -a "$PKG/sandbox" "$BACKUP/sandbox-legacy"

# 3. 解压新包（排除全部用户内容；兼容带根目录前缀的包）
log "解压 $TARBALL（排除 config data run logs）…"
EXCL=(--exclude='config' --exclude='data' --exclude='run' --exclude='logs')
tar -xzf "$TARBALL" -C "$PKG" --strip-components=1 "${EXCL[@]}"

# 4. 旧布局迁移（配置曾在 sandbox/）+ .v1 备份保留
if [ -f "$PKG/sandbox/platform.env" ] && [ ! -f "$CONFIG_DIR/platform.env" ]; then
  mkdir -p "$CONFIG_DIR"
  for f in platform.env piweb.env admin-password.txt; do
    [ -f "$PKG/sandbox/$f" ] && cp -a "$PKG/sandbox/$f" "$CONFIG_DIR/$f"
  done
  log "检测到旧布局配置，已迁移到 config/（原件保留在 sandbox/*.v1-backup 由 start-all 生成）"
fi

# 5. 重启
log "重新启动服务…"
bash "$SCRIPTS/start-all.sh"

log "升级完成。回滚方式（如需）：停服后删除包目录中除 config/data 外的内容，"
log "再解压旧版本包，最后用 $BACKUP 覆盖回 config/ 与 data/。"
