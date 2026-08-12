#!/usr/bin/env bash
#
# install-pi-config.sh — 把包内 config/pi/ 配置模板合并到用户的 agent 目录。
#
# 这是"配置规范分发"的落点：打包者用 PI_CONFIG_DIR 把一套 pi 配置
# （扩展、技能、提示词、主题、模型接口配置等）打进包，目标机首次运行
# 时自动合并到 ~/.pi/agent/（或 PI_CODING_AGENT_DIR 指定的目录）。
#
# 合并规则（安全优先，绝不破坏用户数据）:
#   * 目录类资源（extensions/ skills/ prompts/ themes/ tools/ npm/）:
#       只合入模板里有、目标里没有的文件（cp -an），用户已有文件全部保留。
#       npm/ 是 pi 已安装包与依赖的整树（离线分发）；extensions/ 下可含
#       随包分发的本地扩展包目录（各带 node_modules，打包时预装好依赖），
#       pi 启动时自动发现加载。
#   * 配置文件（models.json / settings.json）:
#       models.json:  目标不存在才安装；--force 时覆盖并先备份到
#                      <agent>/.bundle-backup/。
#       settings.json: 字段级合并 —— 目标不存在则整体安装；已存在则只把模板的
#                      packages 数组并进目标（目标条目优先、按源去重追加），
#                      其余字段（defaultModel 等）一律不动。
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

# 用 node 做 settings.json 的 packages 字段级合并: 目标已有条目优先，
# 模板里新增的条目按"源字符串"（npm:xxx / git:... 等）去重追加，
# 其余字段一律不动。返回 0 = 合并完成（可能无新增）；1 = 无法执行
# （本机无可用 node 或 JSON 解析失败），调用方跳过合并、保持现状。
# node 查找顺序: $PI_NODE > 包内 runtime/bin/node > PATH 中的 node。
merge_settings_packages() {
  local target="$1" bundled="$2"
  local node_bin="${PI_NODE:-}"
  if [ -z "$node_bin" ] && [ -x "$DIR/runtime/bin/node" ]; then
    node_bin="$DIR/runtime/bin/node"
  fi
  if [ -z "$node_bin" ] && command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  fi
  [ -z "$node_bin" ] && return 1
  [ -x "$node_bin" ] || return 1
  PI_MERGE_TARGET="$target" PI_MERGE_BUNDLED="$bundled" "$node_bin" <<'NODE'
const fs = require("fs");
const targetPath = process.env.PI_MERGE_TARGET;
const bundledPath = process.env.PI_MERGE_BUNDLED;
const key = (e) => e && typeof e === "object" ? String(e.source ?? "") : String(e ?? "").trim();
let bundled;
try { bundled = JSON.parse(fs.readFileSync(bundledPath, "utf8")); }
catch { process.exit(1); }
if (!bundled || !Array.isArray(bundled.packages)) process.exit(0);
let target;
try { target = JSON.parse(fs.readFileSync(targetPath, "utf8")); }
catch { process.exit(1); }
if (!Array.isArray(target.packages)) target.packages = [];
const seen = new Set(target.packages.map(key));
let added = 0;
for (const e of bundled.packages) {
  const k = key(e);
  if (k && !seen.has(k)) { target.packages.push(e); seen.add(k); added++; }
}
if (added > 0) {
  fs.writeFileSync(targetPath, JSON.stringify(target, null, 2) + "\n", "utf8");
  console.log(`    settings.json packages 新增 ${added} 个条目`);
} else {
  console.log("    settings.json packages 已包含模板全部条目，无新增");
}
NODE
}

if [ "$DRY" = "1" ]; then
  echo "将应用 pi 配置模板 v$BUNDLED_VER 到 $AGENT_DIR："
else
  mkdir -p "$AGENT_DIR"
fi

applied=0

# 1) 目录类资源：只补缺失文件，绝不覆盖用户已有文件
#    npm/ 整树（离线插件与依赖）；extensions/ 下可含本地扩展包（含各自 node_modules）
for d in extensions skills prompts themes tools npm; do
  [ -d "$BUNDLED/$d" ] || continue
  if [ "$DRY" = "1" ]; then
    echo "  合并 $d/（仅新增缺失文件）"
  else
    mkdir -p "$AGENT_DIR/$d"
    cp -an "$BUNDLED/$d/." "$AGENT_DIR/$d/" 2>/dev/null || true
  fi
  applied=1
done

# 2) 配置文件
#    models.json:  目标不存在才安装；--force 时覆盖（先备份到 .bundle-backup/）
#    settings.json: 字段级合并 —— 只把模板的 packages 数组并进目标
#                    （目标条目优先、按源去重追加），其余字段一律不动。
if [ -f "$BUNDLED/models.json" ]; then
  if [ -f "$AGENT_DIR/models.json" ]; then
    if [ "$FORCE" = "1" ]; then
      run mkdir -p "$AGENT_DIR/.bundle-backup"
      if [ "$DRY" != "1" ]; then
        cp -a "$AGENT_DIR/models.json" "$AGENT_DIR/.bundle-backup/models.json"
      fi
      run cp -a "$BUNDLED/models.json" "$AGENT_DIR/models.json"
      echo "  models.json: 已用模板覆盖（原文件备份到 .bundle-backup/）"
    else
      echo "  models.json: 目标已存在，跳过（如需覆盖: ./install-pi-config.sh --force）"
    fi
  else
    run cp -a "$BUNDLED/models.json" "$AGENT_DIR/models.json"
    echo "  models.json: 已安装"
  fi
  applied=1
fi

if [ -f "$BUNDLED/settings.json" ]; then
  if [ -f "$AGENT_DIR/settings.json" ]; then
    if [ "$DRY" = "1" ]; then
      echo "  settings.json: 目标已存在，将合并模板 packages（其余字段不动）"
    elif merge_settings_packages "$AGENT_DIR/settings.json" "$BUNDLED/settings.json"; then
      echo "  settings.json: 已合并模板 packages（其余字段不动）"
    else
      echo "  settings.json: 合并跳过（本机无可用 node 或解析失败），保持现状"
    fi
  else
    run cp -a "$BUNDLED/settings.json" "$AGENT_DIR/settings.json"
    echo "  settings.json: 已安装"
  fi
  applied=1
fi

if [ "$DRY" = "1" ]; then
  echo "（dry-run 结束，未写入任何文件）"
  exit 0
fi

# 模板里没有可合并内容（例如只放了一份说明文档）→ 不写标记、不打扰用户
[ "$applied" = "1" ] || exit 0

echo "$BUNDLED_VER" > "$MARKER"
echo "已应用 pi 配置模板 v$BUNDLED_VER → $AGENT_DIR（会话与 auth.json 不受影响）"
