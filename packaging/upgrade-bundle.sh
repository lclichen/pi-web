#!/usr/bin/env bash
#
# upgrade-bundle.sh — tar.gz 目录部署的安全原地升级。
#
#   ./scripts/upgrade-bundle.sh /path/to/amedac.ai-pi-linux-x64-<新版本>.tar.gz
#
# 做什么：
#   1. 停止当前服务（保留数据）
#   2. 确保可变内容已收敛到 $AMEDAC_HOME（v3 默认 ~/.local/share/amedac；
#      旧版包内布局先一次性搬迁，见 amedac-home.sh）
#   3. 备份 $AMEDAC_HOME 下的 config/ data/ 到包内快照目录（双保险）
#   4. 解压新版本包覆盖应用代码（数据在包外，不会被触碰）
#   5. 重新启动服务（数据库 schema 由平台幂等迁移自动升级）
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

# 可写区与 start-all 同源（默认每用户 $AMEDAC_HOME，见 amedac-home.sh）
source "$SCRIPTS/amedac-home.sh"
amedac_resolve_dirs
CONFIG_DIR="$AMEDAC_CONFIG_DIR"
DATA_DIR="$DATA_DIR"
BACKUP="$PKG/.upgrade-backup-$(date +%Y%m%d-%H%M%S)"

log() { printf '\033[1;32m>>\033[0m %s\n' "$*"; }

# 1. 停服
bash "$SCRIPTS/stop-all.sh" || true

# 2. 旧版包内布局先搬到 $AMEDAC_HOME（幂等；未迁移的包内数据若直接被
#    新包覆盖会丢失，这一步保证升级前一定收敛完）
amedac_migrate_pkg_dirs "$PKG"

# 3. 升级前把 $AMEDAC_HOME 里的用户内容快照到备份目录（双保险）
log "备份用户内容 → $BACKUP"
mkdir -p "$BACKUP"
[ -d "$CONFIG_DIR" ] && cp -a "$CONFIG_DIR" "$BACKUP/config"
[ -d "$DATA_DIR" ] && cp -a "$DATA_DIR" "$BACKUP/data"
[ -d "$PKG/sandbox" ] && cp -a "$PKG/sandbox" "$BACKUP/sandbox-legacy"

# 4. 解压新包（数据在包外 $AMEDAC_HOME，不会触碰；排除仅兜底旧包残留）
log "解压 $TARBALL …"
EXCL=(--exclude='config' --exclude='data' --exclude='run' --exclude='logs')
tar -xzf "$TARBALL" -C "$PKG" --strip-components=1 "${EXCL[@]}"

# 6. 旧布局迁移（配置曾在 sandbox/）+ .v1 备份保留
if [ -f "$PKG/sandbox/platform.env" ] && [ ! -f "$CONFIG_DIR/platform.env" ]; then
  mkdir -p "$CONFIG_DIR"
  for f in platform.env piweb.env admin-password.txt; do
    [ -f "$PKG/sandbox/$f" ] && cp -a "$PKG/sandbox/$f" "$CONFIG_DIR/$f"
  done
  log "检测到旧布局配置，已迁移到 $CONFIG_DIR/（原件保留在 sandbox/*.v1-backup 由 start-all 生成）"
fi

# 7. 重启
log "重新启动服务…"
bash "$SCRIPTS/start-all.sh"

log "升级完成。用户数据在 $AMEDAC_HOME/（包外，未受影响）。"
log "回滚方式（如需）：停服，用 $BACKUP 覆盖回 $CONFIG_DIR/ 与 $DATA_DIR/，"
log "再对包目录解压旧版本包即可。"
