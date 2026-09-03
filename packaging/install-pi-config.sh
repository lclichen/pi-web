#!/usr/bin/env bash
#
# install-pi-config.sh — 把包内 config/pi/ 配置模板合并到用户的 agent 目录。
#
# 这是"配置规范分发"的落点：打包者用 PI_CONFIG_DIR 把一套 pi 配置
# （扩展、技能、提示词、主题、模型接口配置等）打进包，目标机首次运行
# 时自动合并到 ~/.pi/agent/（或 PI_CODING_AGENT_DIR 指定的目录）。
#
# 大目录（npm/ 与随包 extensions/）的分发模式，两种部署形态默认都是
# 软链模式；用环境变量 AMEDAC_PKG_MODE=copy 可回退到整体拷贝模式:
#   * 软链模式（默认 —— tar.gz 与 AppImage 均适用；调用方可用
#     PI_CONFIG_LINK_ROOT 显式指定包根，未设时脚本自动定位自身所在包）:
#       以符号链接直接接入包内 config/pi/（零拷贝，启动无拷贝耗时，
#       只读内容不落到包外）：
#       - tar.gz：包目录是持久的，链接长期有效，CLI/WebUI 等多个入口
#         共享同一份包内内容；包目录就地升级时内容自动跟随。
#       - AppImage：挂载点随进程消失，--web 以前台监护方式运行（服务
#         是 AppImage 的子进程、随其退出而停止），挂载点在服务存活
#         期间始终有效，链接因此安全；关闭 AppImage 即停止服务。
#       包/挂载路径可能每次启动都不同，所以链接**每次启动无条件刷新**
#       （不受模板版本门控）。
#       残留处理：
#         * 悬空链接（旧挂载/旧包路径已消失）     → 删除后重建
#         * 指向包内但当前模板已不含的扩展链接     → 删除
#         * 用户自建且存活的外置软链               → 保留并跳过
#         * 无版本标记的真实目录（用户自装扩展，或 pi
#           自身维护的 npm/，npm/ 永不写标记）     → 保留，不转软链
#         * 带版本标记的真实目录（拷贝模式早先装的
#           "受管拷贝"，打包者内容）               → 删除后改软链接管
#           （本地改动不保留）；当前模板已不含的受管
#           拷贝目录直接删除
#   * 拷贝模式（AMEDAC_PKG_MODE=copy；需要安装独立于包目录存续时使用，
#     例如装完计划删包）:
#       以**真实目录整体拷贝**分发——分发包本身面向离线免 npm install
#       （node_modules 打包时已预装），拷贝后与包位置完全独立：包目录
#       被移动或删除都不影响。首次拷贝一次性完成，之后按标记幂等跳过。
#       - extensions/ 下随包分发的扩展包（各带 node_modules）是"受管
#         拷贝"：目录内写入 .pi-web-bundle-version 标记记录已应用版本。
#           * 标记版本 == 当前模板版本 → 跳过（幂等，启动零开销）
#           * 模板版本升级或 --force → 删除重建（随包扩展是打包者维护
#             的内容；要自行修改请先另存一份到新目录名）
#           * 有标记但本模板中已不存在的目录（升级后改名/移除）→ 删除
#           * 无标记的真实目录（用户自装扩展，即使同名）→ 只补缺失
#             文件（cp -an），绝不覆盖、绝不删除
#       - npm/（pi 已安装包与依赖的整树）: 首次整体拷贝，之后只补缺失
#         文件 —— npm/ 由 pi 自身主动维护（pi install/uninstall
#         会写入），永不覆盖、永不删除。
#       - 存量软链（含软链模式所建、以及旧版 v2 及以前的链接残留）
#         → 删除并以拷贝接管。
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
# PI_CONFIG_VERSION（当前 3），目标机下次启动时自动应用增量。当前已应用
# 版本记录在 <agent>/.bundle-version。
#   * 软链模式: npm/ 与扩展内容经链接直接取自包，包更新内容即更新；
#     版本门控只管 skills/ 等新文件补缺与配置文件合并。
#   * 拷贝模式: 受管扩展重建到新版、陈旧受管扩展目录删除、npm/ 与
#     新文件补缺。
#
# 用法:
#   ./install-pi-config.sh            # 自动判断是否应用（幂等，无事可做时静默）
#   ./install-pi-config.sh --force    # 强制重新应用（受管扩展重建 + 配置文件覆盖并备份）
#   ./install-pi-config.sh --dry-run  # 只看会做什么，不实际写入
#
# 环境变量:
#   AMEDAC_PKG_MODE=copy   整体拷贝模式（默认 link 软链模式）
#   PI_CONFIG_LINK_ROOT    显式指定包根（内含 config/pi/，由调用方注入）
#
# pi / pi-web.sh / AppRun 会自动调用本脚本；也可手动运行。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 本脚本通常位于包内 scripts/ 子目录，包根为上一级；但软链模式允许调用方
# 用 PI_CONFIG_LINK_ROOT 指定另一份包根（AppImage 挂载点），以该值为准。
ROOT="$(dirname "$DIR")"
BUNDLED_ROOT="${PI_CONFIG_LINK_ROOT:-$ROOT}"
BUNDLED="$BUNDLED_ROOT/config/pi"
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

# 受管拷贝目录的版本标记（拷贝模式写入；软链模式据此识别"受管内容"）
EXT_MARKER=".pi-web-bundle-version"

note() { printf '  %s\n' "$*"; }

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
  if [ -z "$node_bin" ] && [ -x "$BUNDLED_ROOT/runtime/bin/node" ]; then
    node_bin="$BUNDLED_ROOT/runtime/bin/node"
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

applied=0

# ============================================================================
# 0) 软链模式（默认，tar.gz 与 AppImage 均适用）: npm/ 与随包 extensions/
#    直接软链到包内，包外不落地任何只读内容（零拷贝）。包/挂载路径可能
#    每次启动都不同，所以链接**每次启动无条件刷新**（不受模板版本门控）；
#    无版本标记的真实目录（用户自装扩展、pi 自维护的 npm/）保留不碰，
#    带版本标记的受管拷贝目录（拷贝模式早前所装）删除后改软链接管。
#    AMEDAC_PKG_MODE=copy 时本节整体跳过（走下方拷贝模式）。
# ============================================================================
PKG_MODE="${AMEDAC_PKG_MODE:-link}"
case "$PKG_MODE" in
  copy)  LINK_MODE=0 ;;
  link)  LINK_MODE=1 ;;
  *) echo "未知的 AMEDAC_PKG_MODE: $PKG_MODE（允许值: link / copy）" >&2; exit 2 ;;
esac

if [ "$LINK_MODE" = "1" ]; then
  # 删除链接残留（DRY 感知）。只删软链，绝不触碰真实目录/文件。
  link_rm() { # <路径> <原因>
    if [ "$DRY" = "1" ]; then
      note "[dry] 删除软链 $(basename "$1")（$2）"
    else
      rm -f "$1"
      note "删除残留软链 $(basename "$1")（$2）"
    fi
  }

  # 上一轮运行残留清理：悬空软链（旧挂载已随进程退出消失、或旧包路径
  # 已被移动/删除）一律删除；指向包内路径（本工具历史产物）但当前模板
  # 已不再包含的同名扩展链接也删除（多个包并存时旧包路径仍存活才会遇到）；
  # 用户自建且存活的外置软链保留不动。
  if [ -d "$AGENT_DIR/extensions" ]; then
    for entry in "$AGENT_DIR/extensions"/*; do
      [ -L "$entry" ] || continue
      if [ ! -e "$entry" ]; then
        link_rm "$entry" "悬空链接（上轮挂载已消失）"
        continue
      fi
      case "$(readlink "$entry")" in
        */config/pi/extensions/*)
          [ -d "$BUNDLED/extensions/$(basename "$entry")" ] \
            || link_rm "$entry" "当前模板已不含 $(basename "$entry")"
          ;;
      esac
    done
  fi
  if [ -L "$AGENT_DIR/npm" ] && [ ! -e "$AGENT_DIR/npm" ]; then
    link_rm "$AGENT_DIR/npm" "悬空链接（上轮挂载已消失）"
  fi

  link_one() { # <目标路径> <包内源> —— 刷新指向包内源的软链
    local dst="$1" src="$2"
    [ -d "$src" ] || return 0
    if [ -L "$dst" ] && [ -e "$dst" ]; then
      case "$(readlink "$dst")" in
        */config/pi/npm | */config/pi/extensions/*)
          : # 本工具历史产物（旧挂载/旧包路径仍存活）→ 刷新指向当前包
          ;;
        *)
          note "$(basename "$dst"): 已存在指向包外的软链（$(readlink "$dst")），保留并跳过"
          return 0   # 用户自建且存活的外置软链 → 保留
          ;;
      esac
    elif [ -L "$dst" ] || [ ! -e "$dst" ]; then
      : # 悬空链接（或刚被清理）/ 尚不存在 → 刷新
    elif [ -d "$dst" ]; then
      # 真实目录：拷贝模式早前装的"受管拷贝"（带版本标记，打包者内容）
      # 删除后改软链接管；无标记的真实目录（用户自装扩展，或 pi 自身
      # 维护的 npm/ —— npm/ 永不写标记）保留，不转软链。
      if [ -f "$dst/$EXT_MARKER" ] && [ "$(dirname "$dst")" = "$AGENT_DIR/extensions" ]; then
        applied=1
        if [ "$DRY" = "1" ]; then
          note "[dry] $(basename "$dst"): 受管拷贝 v$(cat "$dst/$EXT_MARKER" 2>/dev/null || echo '?') → 改为包内软链（本地改动不保留）"
        else
          rm -rf "$dst"
          ln -s "$src" "$dst"
          note "$(basename "$dst"): 受管拷贝已改由包内软链接管（零拷贝，本地改动不保留）"
        fi
      fi
      return 0
    else
      note "$(basename "$dst"): 目标已存在但不是目录，跳过（请人工检查 $dst）"
      return 0
    fi
    applied=1
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
      return 0   # 已指向本包当前路径，无需重写
    fi
    if [ "$DRY" = "1" ]; then
      note "[dry] $(basename "$dst") -> $src（软链，零拷贝）"
    else
      mkdir -p "$(dirname "$dst")"
      ln -sfn "$src" "$dst"
      note "$(basename "$dst") -> 包内软链（内容留在包内，零拷贝）"
    fi
  }

  [ -d "$BUNDLED/npm" ] && link_one "$AGENT_DIR/npm" "$BUNDLED/npm"
  if [ -d "$BUNDLED/extensions" ]; then
    for ext in "$BUNDLED/extensions"/*; do
      [ -d "$ext" ] || continue
      link_one "$AGENT_DIR/extensions/$(basename "$ext")" "$ext"
    done
  fi

  # 陈旧的受管拷贝（带版本标记的真实目录、当前模板已不含，如升级后
  # 改名/移除）→ 删除（与拷贝模式的陈旧清理等价；无标记的用户目录不碰）
  if [ -d "$AGENT_DIR/extensions" ]; then
    for dir in "$AGENT_DIR/extensions"/*/; do
      [ -d "$dir" ] || continue
      [ -f "${dir}$EXT_MARKER" ] || continue
      name="$(basename "${dir%/}")"
      if [ ! -d "$BUNDLED/extensions/$name" ]; then
        if [ "$DRY" = "1" ]; then
          note "[dry] 删除陈旧受管扩展 $name（当前模板中已不包含）"
        else
          rm -rf "${dir%/}"
          note "删除陈旧受管扩展 $name（当前模板中已不包含）"
        fi
      fi
    done
  fi

  # 链接已刷新；版本未变且非 --force → 其余（skills/配置文件）上一版
  # 首启时已处理过，无事可做，静默退出。
  if [ "$FORCE" = "0" ] && [ -n "$APPLIED_VER" ] && [ "$APPLIED_VER" = "$BUNDLED_VER" ]; then
    exit 0
  fi
fi

# 旧版（v2 及以前）链接残留识别：v2 只产生指向包内 config/pi/npm 或
# config/pi/extensions/<名> 的软链（AppImage 场景第一跳是
# AMEDAC_HOME/current，其路径同样以 config/pi/… 结尾）。据此区分
# "本脚本历史产物"与"用户自建软链"。
legacy_link_target() { # 路径 -> 若是旧版链接残留则打印其目标，否则返回 1
  local p="$1" tgt
  [ -L "$p" ] || return 1
  tgt="$(readlink "$p")"
  case "$tgt" in
    */config/pi/npm | */config/pi/extensions/*) printf '%s\n' "$tgt"; return 0 ;;
  esac
  return 1
}

# 拷贝模式的应用判定：--force、从未应用过、模板版本升级、或目标里还留着
# 失效/残留软链（指向已消失的挂载目录或旧包路径，含软链模式所建 —— 需要
# 清理并用拷贝接管；迁移不依赖打包者是否递增版本号）。
if [ "$LINK_MODE" = "0" ]; then
  needs_migration=0
  for p in "$AGENT_DIR/npm" "$AGENT_DIR/extensions"/*; do
    if [ -L "$p" ]; then
      if [ ! -e "$p" ] || legacy_link_target "$p" >/dev/null; then
        needs_migration=1
        break
      fi
    fi
  done

  if [ "$FORCE" = "1" ]; then
    apply=1
  elif [ -n "$APPLIED_VER" ] && [ "$APPLIED_VER" = "$BUNDLED_VER" ] && [ "$needs_migration" = "0" ]; then
    apply=0
  else
    apply=1
  fi
  [ "$apply" = "1" ] || exit 0
fi

# ---- 旧版（v2）软链清理（识别规则见上方 legacy_link_target）--------------
remove_stale_link() { # 路径 原因 —— 删除应清理的软链（绝不触碰真实目录/文件）
  local p="$1" reason="$2" tgt
  [ -L "$p" ] || return 0
  tgt="$(readlink "$p")"
  if [ "$DRY" = "1" ]; then
    note "[dry] 删除软链 $p -> $tgt（$reason）"
  else
    rm -f "$p"
    note "删除旧软链 $(basename "$p") -> $tgt（$reason）"
  fi
}

if [ "$DRY" = "1" ]; then
  echo "将应用 pi 配置模板 v$BUNDLED_VER 到 $AGENT_DIR："
else
  mkdir -p "$AGENT_DIR"
fi

# ============================================================================
# 1) 拷贝模式（AMEDAC_PKG_MODE=copy）：npm/ 与随包 extensions/ 的真实
#    拷贝分发（默认软链模式已在上方第 0 节完成链接，跳过本节）
# ============================================================================
if [ "$LINK_MODE" = "0" ]; then

# ---- extensions/：先清理旧版软链残留，再逐个安装随包扩展 ------------------
if [ "$DRY" != "1" ]; then
  mkdir -p "$AGENT_DIR/extensions"
fi
if [ -d "$AGENT_DIR/extensions" ]; then
  for entry in "$AGENT_DIR/extensions"/*; do
    [ -L "$entry" ] || continue
    if [ -e "$entry" ]; then
      # 存留软链：指向包内 config/pi/ 的 = v2 链接模式残留，删除（稍后以拷贝接管）；
      # 指向包外的 = 用户自建，保留，安装循环里会跳过该项。
      if legacy_link_target "$entry" >/dev/null; then
        remove_stale_link "$entry" "v2 链接模式残留，改为真实拷贝"
      fi
    else
      remove_stale_link "$entry" "悬空链接（目标目录已消失）"
    fi
  done
fi

install_ext() { # <包内扩展目录> <目标扩展目录>
  local src="$1" dst="$2" name cur
  name="$(basename "$dst")"
  [ -d "$src" ] || return 0
  if [ ! -e "$dst" ]; then
    # 不存在（首次安装，或旧软链刚被清理）：整体拷贝 + 写标记
    if [ "$DRY" = "1" ]; then
      note "[dry] extensions/$name -> 整体拷贝（含 node_modules，离线可用）"
    else
      cp -a "$src" "$dst"
      echo "$BUNDLED_VER" > "$dst/$EXT_MARKER"
      note "extensions/$name: 已整体拷贝（离线，无需安装依赖）"
    fi
    return 0
  fi
  if [ ! -d "$dst" ]; then
    note "extensions/$name: 目标已存在但不是目录，跳过（请人工检查 $dst）"
    return 0
  fi
  if [ -f "$dst/$EXT_MARKER" ]; then
    # 受管拷贝（由本工具从包中拷出）
    cur="$(cat "$dst/$EXT_MARKER" 2>/dev/null || echo "")"
    if [ "$cur" = "$BUNDLED_VER" ] && [ "$FORCE" != "1" ]; then
      return 0   # 已是最新模板版本
    fi
    if [ "$DRY" = "1" ]; then
      note "[dry] extensions/$name: 受管拷贝 v${cur:-?}，将重建到 v$BUNDLED_VER（本地改动不保留）"
    else
      rm -rf "$dst"
      cp -a "$src" "$dst"
      echo "$BUNDLED_VER" > "$dst/$EXT_MARKER"
      note "extensions/$name: 已重建到 v$BUNDLED_VER（随包内容由打包者维护，本地改动不保留）"
    fi
  else
    # 用户自装扩展（与随包目录同名）：只补缺失文件，绝不覆盖
    if [ "$DRY" = "1" ]; then
      note "[dry] extensions/$name: 用户目录，只补缺失文件"
    else
      cp -an "$src/." "$dst/" 2>/dev/null || true
    fi
  fi
}

if [ -d "$BUNDLED/extensions" ]; then
  for ext in "$BUNDLED/extensions"/*; do
    [ -d "$ext" ] || continue
    applied=1
    install_ext "$ext" "$AGENT_DIR/extensions/$(basename "$ext")"
  done
fi
# 陈旧的受管扩展（有标记但本模板中已不存在，如升级后改名/移除）→ 删除。
# 注意：无论模板当前是否还有 extensions/ 目录都要执行——模板完全去掉
# extensions 时恰恰是最需要清理的场景。
if [ -d "$AGENT_DIR/extensions" ]; then
  for dir in "$AGENT_DIR/extensions"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "${dir%/}")"
    [ -f "${dir}$EXT_MARKER" ] || continue   # 非本工具分发的目录 → 不碰
    if [ ! -d "$BUNDLED/extensions/$name" ]; then
      if [ "$DRY" = "1" ]; then
        note "[dry] 删除陈旧受管扩展 $name（当前模板中已不包含）"
      else
        rm -rf "${dir%/}"
        note "删除陈旧受管扩展 $name（当前模板中已不包含）"
      fi
    fi
  done
fi

fi   # ---- 拷贝模式结束（软链模式跳过整个本节）----

# ---- skills/ prompts/ themes/ tools/：小目录，只补缺失文件（两种模式共用）---------------
for d in skills prompts themes tools; do
  [ -d "$BUNDLED/$d" ] || continue
  if [ "$DRY" = "1" ]; then
    note "合并 $d/（仅新增缺失文件）"
  else
    mkdir -p "$AGENT_DIR/$d"
    cp -an "$BUNDLED/$d/." "$AGENT_DIR/$d/" 2>/dev/null || true
  fi
  applied=1
done

# ---- npm/（pi 已安装包与依赖整树，离线分发；仅拷贝模式，软链模式在第 0 节已链接）----
if [ "$LINK_MODE" = "0" ]; then
if [ -d "$BUNDLED/npm" ]; then
  applied=1
  NPM_DST="$AGENT_DIR/npm"
  if [ -L "$NPM_DST" ] && [ -e "$NPM_DST" ] && ! legacy_link_target "$NPM_DST" >/dev/null; then
    # 用户自建且存活的包外软链：保留，跳过
    note "npm/: 已存在指向包外的软链（$(readlink "$NPM_DST")），保留并跳过"
  else
    was_link=0
    if [ -L "$NPM_DST" ]; then
      was_link=1
      remove_stale_link "$NPM_DST" "v2 链接模式残留/悬空链接，改为真实拷贝"
    fi
    if [ "$was_link" = "0" ] && [ -e "$NPM_DST" ] && [ ! -d "$NPM_DST" ]; then
      note "npm/: 目标已存在但不是目录，跳过（请人工检查 $NPM_DST）"
    elif [ "$DRY" = "1" ]; then
      if [ "$was_link" = "0" ] && [ -d "$NPM_DST" ]; then
        note "[dry] npm/: 只补缺失文件（npm/ 由 pi 自身维护，不覆盖）"
      else
        note "[dry] npm/ -> 整体拷贝（插件与依赖整树，离线可用）"
      fi
    elif [ "$was_link" = "0" ] && [ -d "$NPM_DST" ]; then
      # 已有真实目录（含用户 pi install 过的包）：只补缺失文件
      cp -an "$BUNDLED/npm/." "$NPM_DST/" 2>/dev/null || true
    else
      # 首次安装（或旧软链刚被清理）：整体拷贝
      cp -a "$BUNDLED/npm" "$NPM_DST"
      note "npm/: 已整体拷贝（插件与依赖整树，离线，无需安装依赖）"
    fi
  fi
fi
fi   # ---- npm（仅拷贝模式）结束 ----

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
