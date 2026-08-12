#!/usr/bin/env bash
#
# install-pi-config.sh — 把包内 config/pi/ 配置模板合并到用户的 agent 目录。
#
# 这是"配置规范分发"的落点：打包者用 PI_CONFIG_DIR 把一套 pi 配置
# （扩展、技能、提示词、主题、模型接口配置等）打进包，目标机首次运行
# 时自动合并到 ~/.pi/agent/（或 PI_CODING_AGENT_DIR 指定的目录）。
#
# 合并规则（安全优先，绝不破坏用户数据）:
#   * 目录类资源（extensions/ skills/ prompts/ themes/ tools/）:
#       只合入模板里有、目标里没有的文件（cp -an），用户已有文件全部保留。
#   * 配置文件（models.json / settings.json）:
#       目标不存在才安装；--force 时覆盖并先备份到
#       <agent>/.bundle-backup/。
#   * 从不触碰: sessions/（会话）、auth.json（凭证）、bin/（托管二进制）、
#       tmp/，以及用户的任何其他文件。
#
# 增量更新: config/pi/.bundle-version 记录模板版本。发布新包时递增
# PI_CONFIG_VERSION，目标机下次启动时自动合并增量（新版本模板里新增的
# 文件会合入，已有文件仍不覆盖）。当前已应用版本记录在
# <agent>/.bundle-version。
#
# 用法:
#   ./install-pi-config.sh            # 自动判断是否应用（幂等，无事可做时静默）
#   ./install-pi-config.sh --force    # 强制重新应用（配置文件覆盖 + 备份）
#   ./install-pi-config.sh --dry-run  # 只看会做什么，不实际写入
#
# pi / pi-web.sh 会自动调用本脚本；也可手动运行。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLED="$DIR/config/pi"
FORCE=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "未知参数: $arg（支持 --force / --dry-run）" >&2; exit 2 ;;
  esac
done

# 没有打包配置模板（精简包）→ 无事可做
[ -d "$BUNDLED" ] || exit 0

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

BUNDLED_VER="$(cat "$BUNDLED/.bundle-version" 2>/dev/null || echo "1")"
MARKER="$AGENT_DIR/.bundle-version"
APPLIED_VER="$(cat "$MARKER" 2>/dev/null || echo "")"

# 是否这次要应用：--force，或从未应用过，或模板版本升级了
if [ "$FORCE" = "1" ]; then
  apply=1
elif [ -n "$APPLIED_VER" ] && [ "$APPLIED_VER" = "$BUNDLED_VER" ]; then
  apply=0
else
  apply=1
fi
[ "$apply" = "1" ] || exit 0

run() {
  if [ "$DRY" = "1" ]; then
    echo "  (dry-run) $*"
  else
    "$@"
  fi
}

if [ "$DRY" = "1" ]; then
  echo "将应用 pi 配置模板 v$BUNDLED_VER 到 $AGENT_DIR："
else
  mkdir -p "$AGENT_DIR"
fi

applied=0

# 1) 目录类资源：只补缺失文件，绝不覆盖用户已有文件
for d in extensions skills prompts themes tools; do
  [ -d "$BUNDLED/$d" ] || continue
  if [ "$DRY" = "1" ]; then
    echo "  合并 $d/（仅新增缺失文件）"
  else
    mkdir -p "$AGENT_DIR/$d"
    cp -an "$BUNDLED/$d/." "$AGENT_DIR/$d/" 2>/dev/null || true
  fi
  applied=1
done

# 2) 配置文件：目标不存在才安装；--force 时覆盖（先备份到 .bundle-backup/）
for f in models.json settings.json; do
  [ -f "$BUNDLED/$f" ] || continue
  if [ -f "$AGENT_DIR/$f" ]; then
    if [ "$FORCE" = "1" ]; then
      run mkdir -p "$AGENT_DIR/.bundle-backup"
      if [ "$DRY" != "1" ]; then
        cp -a "$AGENT_DIR/$f" "$AGENT_DIR/.bundle-backup/$f"
      fi
      run cp -a "$BUNDLED/$f" "$AGENT_DIR/$f"
      echo "  $f: 已用模板覆盖（原文件备份到 .bundle-backup/）"
    else
      echo "  $f: 目标已存在，跳过（如需覆盖: ./install-pi-config.sh --force）"
    fi
  else
    run cp -a "$BUNDLED/$f" "$AGENT_DIR/$f"
    echo "  $f: 已安装"
  fi
  applied=1
done

if [ "$DRY" = "1" ]; then
  echo "（dry-run 结束，未写入任何文件）"
  exit 0
fi

# 模板里没有可合并内容（例如只放了一份说明文档）→ 不写标记、不打扰用户
[ "$applied" = "1" ] || exit 0

echo "$BUNDLED_VER" > "$MARKER"
echo "已应用 pi 配置模板 v$BUNDLED_VER → $AGENT_DIR（会话与 auth.json 不受影响）"
