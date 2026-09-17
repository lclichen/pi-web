#!/usr/bin/env bash
# amedac-home.sh — 可写数据目录的统一解析与旧布局迁移（tar.gz / AppImage 共用）。
#
# 设计（与 AppImage AppRun v4 对齐，tar.gz 自 v3 起同样收敛）：包体保持
# 只读、可放多人共享位置（如 /opt），全部可变内容落到每用户主目录：
#
#   AMEDAC_HOME  默认 ${XDG_DATA_HOME:-$HOME/.local/share}/amedac
#     config/    platform.env、piweb.env、admin-password.txt（首启生成）
#     data/      平台 sqlite/overlay/镜像/工作区、WebUI 数据（更新不丢）
#     run/       pid 与 ports.env
#     logs/      服务日志
#
# 已显式设置的 AMEDAC_HOME / AMEDAC_CONFIG_DIR / AMEDAC_RUN_DIR /
# AMEDAC_LOG_DIR / DATA_DIR 环境变量一律优先（AppRun 即走这条路），
# 本文件只补默认值，不覆盖任何已有决定。
#
# 用法（各兄弟脚本 source 后调用；本文件位于包内 scripts/ 或仓库 packaging/）：
#   source <本文件>
#   amedac_resolve_dirs             # 仅补默认值（幂等，不建目录）
#   amedac_migrate_pkg_dirs <包根>  # 旧版包内布局一次性搬迁（幂等）：
#                                   # config 三件套 + data/{platform,piweb}
#                                   # + app/data，并改写 env 文件里的旧路径
#
# 迁移规则：仅当目标不存在时搬移（多人共用/重复启动天然幂等）；
# 包内 config/pi 模板与 update-url.txt 属随包只读内容，永远保持原地。
# 旧版单用户包内数据会被**首个启动新版脚本的用户**整体迁走，其余用户
# 各自获得全新初始化的数据目录。

_amedac_log()  { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
_amedac_warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

amedac_resolve_dirs() {
  AMEDAC_HOME="${AMEDAC_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/amedac}"
  export AMEDAC_HOME
  export AMEDAC_CONFIG_DIR="${AMEDAC_CONFIG_DIR:-$AMEDAC_HOME/config}"
  export AMEDAC_RUN_DIR="${AMEDAC_RUN_DIR:-$AMEDAC_HOME/run}"
  export AMEDAC_LOG_DIR="${AMEDAC_LOG_DIR:-$AMEDAC_HOME/logs}"
  export DATA_DIR="${DATA_DIR:-$AMEDAC_HOME/data}"
}

# _amedac_mv_in <src> <dst> — 目标不存在时整体搬移；跨文件系统 mv 自带
# 拷贝语义，失败则 cp 兜底并把原件改名 .v3-backup 留在原处。
_amedac_mv_in() {
  [ -e "$1" ] || return 1
  mkdir -p "$(dirname "$2")" 2>/dev/null || return 1
  if mv "$1" "$2" 2>/dev/null; then return 0; fi
  if cp -a "$1" "$2" 2>/dev/null; then
    mv "$1" "$1.v3-backup" 2>/dev/null || true
    return 0
  fi
  return 1
}

# _amedac_rewrite_env_paths <file> <旧包根> — 生成型 env 文件里以旧包路径
# 为前缀的数据目录变量（DB_SQLITE_PATH / *_BASE_DIR / PI_WEB_DATA_DIR）
# 统一改指新的 $DATA_DIR；用户手写的其它路径不受影响。
_amedac_rewrite_env_paths() {
  local f="$1" pkg="$2"
  [ -f "$f" ] || return 0
  sed -i "s#$pkg/app/data#$DATA_DIR/piweb#g; s#$pkg/data#$DATA_DIR#g" "$f" 2>/dev/null || true
}

amedac_migrate_pkg_dirs() {
  local pkg="$1" f d moved=0
  [ -n "$pkg" ] && [ -d "$pkg" ] || return 0
  [ -n "${AMEDAC_CONFIG_DIR:-}" ] && [ -n "${DATA_DIR:-}" ] || return 0

  # ① 运行配置三件套（包内 config/ → $AMEDAC_CONFIG_DIR），搬完改写其中
  #    写死的旧数据路径。config/pi/、update-url.txt 等随包只读内容不动。
  if [ -d "$pkg/config" ]; then
    for f in platform.env piweb.env admin-password.txt; do
      if [ -f "$pkg/config/$f" ] && [ ! -e "$AMEDAC_CONFIG_DIR/$f" ]; then
        if _amedac_mv_in "$pkg/config/$f" "$AMEDAC_CONFIG_DIR/$f"; then
          case "$f" in *.env) _amedac_rewrite_env_paths "$AMEDAC_CONFIG_DIR/$f" "$pkg" ;; esac
          _amedac_log "已迁移包内 config/$f → $AMEDAC_CONFIG_DIR/"
          moved=1
        else
          _amedac_warn "迁移 config/$f 失败（保留包内原文件，服务将沿用旧路径）"
        fi
      fi
    done
  fi

  # ② 平台/WebUI 数据（旧版 tar.gz 的 <包>/data/{platform,piweb} → $DATA_DIR）
  if [ -d "$pkg/data" ]; then
    for d in platform piweb; do
      if [ -d "$pkg/data/$d" ] && [ ! -e "$DATA_DIR/$d" ]; then
        if _amedac_mv_in "$pkg/data/$d" "$DATA_DIR/$d"; then
          _amedac_log "已迁移包内 data/$d → $DATA_DIR/"
          moved=1
        else
          _amedac_warn "迁移 data/$d 失败（保留包内原目录，请手动搬迁）"
        fi
      fi
    done
  fi

  # ③ 独立 WebUI 启动器的旧回落目录（cwd/data = <包>/app/data）→ data/piweb
  if [ -d "$pkg/app/data" ] && [ ! -e "$pkg/app/data.v3-backup" ]; then
    if [ ! -e "$DATA_DIR/piweb" ]; then
      if _amedac_mv_in "$pkg/app/data" "$DATA_DIR/piweb"; then
        _amedac_log "已迁移包内 app/data → $DATA_DIR/piweb/"
        moved=1
      else
        _amedac_warn "迁移 app/data 失败（保留包内原目录，请手动搬迁）"
      fi
    else
      _amedac_warn "包内 app/data 与 $DATA_DIR/piweb 并存：保留两者，如需合并请手动处理"
    fi
  fi

  # ④ env 文件若仍引用旧包路径（含 ① 之前被手动挪到 $HOME 的情况）补一次改写
  for f in platform.env piweb.env; do
    if [ -f "$AMEDAC_CONFIG_DIR/$f" ] && grep -q "$pkg/" "$AMEDAC_CONFIG_DIR/$f" 2>/dev/null; then
      _amedac_rewrite_env_paths "$AMEDAC_CONFIG_DIR/$f" "$pkg"
      _amedac_log "$f 中的旧包内数据路径已改写为 $DATA_DIR/"
    fi
  done

  [ "$moved" = "1" ] && _amedac_log "旧版包内数据已收敛到 $AMEDAC_HOME/（包目录此后可只读共享、整体更新）"
  return 0
}
