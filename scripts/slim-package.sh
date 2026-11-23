#!/usr/bin/env bash
#
# slim-package.sh — Linux 发布包独立瘦身脚本。
#
# 对已组装好的包目录（package-linux.sh 第 7~8c 步之后的产物布局）删除运行时
# 用不到的构建残留，安全项默认全部执行；不修改包外任何源码/依赖。
#
# 用法:
#   bash scripts/slim-package.sh [包根目录] [选项]
#   bash scripts/slim-package.sh                    # 自动探测 build/package-linux*/amedac.ai-pi-linux-*
#   bash scripts/slim-package.sh /path/to/pkg --dry-run
#
# 选项:
#   --dry-run       只报告将删除的内容与预计节省，不做任何修改
#   --aggressive    额外删除“需冒烟验证”的项目（默认关闭，见第 8 步注释）
#   --help          显示本说明
#
# 默认删除项（均为运行时不加载的构建残留）:
#   1. sourcemap        包内所有 *.map（next/dist 89M、lucide-react 16M 等，
#                       运行时永不加载，仅调试器读取；打包脚本只清了 .next 的）
#   2. TS 声明文件      app/node_modules、config/pi、sandbox/platform 下的
#                       *.d.ts / *.d.mts 与 @types 目录
#   3. monaco-editor    app/node_modules/monaco-editor 整包（106M）。
#                       前端经 loader.config({paths:{vs:"/monaco/vs"}}) 加载
#                       public/monaco 自托管 AMD 资源；npm 包只被构建机的
#                       prebuild 脚本 copy-monaco.mjs 读取，运行时不引用
#   3b. sharp/libvips   Next 的可选图片优化后端；next.config.ts 已设置
#                       images.unoptimized=true，默认删除 sharp、@img/sharp-*、
#                       @img/colour（同时移除 LGPL libvips）
#   4. recheck 可选后端 config/pi 扩展依赖树里的 recheck-jar（Java JAR，23M）
#                       与非 Linux 平台 recheck-{macos,windows}-* 原生二进制。
#                       **保留 recheck-linux-*（目标机是 Linux）；删除 Linux 原生
#                       包需要 --aggressive + 实际 checkSync 冒烟验证。**
#   5. .next 开发残留   app/.next/types（typedRoutes 类型输出）/ trace（构建
#                       遥测）/ cache / dev（若残留）
#
# 明确不自动处理（发布人手工清理）:
#   - runtime/bin/node 的符号表：strip 有损坏可执行文件的风险，不纳入自动流水线
#   - config/pi/extensions 下的视频/测试/示例/media/banner：可能与运行时资源重叠
#
# 明确保留（历史教训——glibc 2.28 平台启动时原生 SWC 绑定加载失败会回退
# wasm，两者缺一不可）:
#   - app/node_modules/next/wasm              （glibc < 2.29 的 SWC 回退）
#   - app/node_modules/@next/swc-linux-x64-gnu（新平台原生绑定）
#   - runtime/lib（npm/corepack，离线 npx 需要）、bin/（fd/rg）、
#     app/agent/、config/pi/npm/、pi-coding-agent vendor 等
#   - sharp/@img/sharp-* 仅在 next.config.ts 启用图片优化时保留；当前
#     images.unoptimized=true，默认移除（见第 3b 步）
#
# 结束时的完整性自检会确认上述保留项仍在位，并输出前后体积对比。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

DRY_RUN=0
AGGRESSIVE=0
PKG=""
for a in "$@"; do
  case "$a" in
    --dry-run)    DRY_RUN=1 ;;
    --aggressive) AGGRESSIVE=1 ;;
    --help|-h)    sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)           die "未知选项: $a（--help 查看用法）" ;;
    *)            PKG="$a" ;;
  esac
done

# ---------------------------------------------------------------------------
# 0. 定位并校验包根
# ---------------------------------------------------------------------------
if [ -z "$PKG" ]; then
  CANDIDATES="$(find "$ROOT/build" -maxdepth 2 -type d -name 'amedac.ai-pi-linux-*' 2>/dev/null | sort)"
  [ -n "$CANDIDATES" ] || die "未指定包根目录，且 $ROOT/build 下找不到 amedac.ai-pi-linux-*"
  [ "$(printf '%s\n' "$CANDIDATES" | wc -l)" -eq 1 ] \
    || die "找到多个候选包根，请显式指定: $(printf '%s\n' "$CANDIDATES" | tr '\n' ' ')"
  PKG="$CANDIDATES"
fi
[ -d "$PKG" ] || die "包根目录不存在: $PKG"
PKG="$(cd "$PKG" && pwd)"
[ -d "$PKG/app/node_modules" ] || die "$PKG 不像已组装的包（缺 app/node_modules）"

human() { awk -v b="$1" 'BEGIN{
  split("B KiB MiB GiB TiB",u," "); i=1; x=b+0
  while (x>=1024 && i<5) { x/=1024; i++ }
  if (x>=10 || i<=1) printf "%d %s", x, u[i]
  else printf "%.1f %s", x, u[i] }'; }

size_of() { du -sb "$@" 2>/dev/null | awk '{s+=$1} END{print s+0}'; }

TOTAL_BEFORE="$(size_of "$PKG")"
log "目标包: $PKG"
log "瘦身前: $(human "$TOTAL_BEFORE")"
[ "$DRY_RUN" = "1" ] && warn "dry-run 模式：只报告，不修改"
[ "$AGGRESSIVE" = "1" ] && warn "aggressive 模式：包含需冒烟验证的删除项"

# 步骤记账
STEPS=()
SAVED_SUM=0
record() { # <名称> <节省字节>
  STEPS+=("$(printf '%-34s %s' "$1" "$(human "$2")")")
  SAVED_SUM=$((SAVED_SUM + $2))
}

# ---------------------------------------------------------------------------
# 1. sourcemap：全包（除 runtime）的 *.map
# ---------------------------------------------------------------------------
MAP_BYTES="$(find "$PKG" -path "$PKG/runtime" -prune -o -type f -name '*.map' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')"
if [ "$DRY_RUN" = "1" ]; then
  record "sourcemap (*.map)" "$MAP_BYTES"
else
  # -prune 与 -delete 不能同用（-delete 强制 -depth 使 -prune 失效），改用 -print0 | xargs
  find "$PKG" -path "$PKG/runtime" -prune -o -type f -name '*.map' -print0 2>/dev/null \
    | xargs -0 -r rm -f
  record "sourcemap (*.map)" "$MAP_BYTES"
fi

# ---------------------------------------------------------------------------
# 2. TS 声明文件（.d.ts/.d.mts）与 @types 目录
#    范围: app/node_modules、config/pi、sandbox/platform —— 运行时（含 pi 的
#    node 类型剥离加载）都不会读取类型声明
# ---------------------------------------------------------------------------
DTYPES=("$PKG/app/node_modules" "$PKG/config/pi" "$PKG/sandbox/platform")
DTYPES_EXIST=()
for d in "${DTYPES[@]}"; do [ -d "$d" ] && DTYPES_EXIST+=("$d"); done
DTS_BYTES="$(find "${DTYPES_EXIST[@]}" -type f \( -name '*.d.ts' -o -name '*.d.mts' \) -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')"
TYPES_BYTES=0
for d in "${DTYPES_EXIST[@]:-}"; do
  b="$(find "$d" -type d -name '@types' -prune 2>/dev/null | while read -r t; do
         s="$(du -sb "$t" 2>/dev/null | cut -f1)"; echo "${s:-0}"
       done | awk '{s+=$1} END{print s+0}')"
  TYPES_BYTES=$((TYPES_BYTES + b))
done
ATYPES_BYTES="$TYPES_BYTES"
if [ "$DRY_RUN" = "1" ]; then
  record "TS 声明 (.d.ts/@types)" "$((DTS_BYTES + ATYPES_BYTES))"
else
  [ -n "${DTYPES_EXIST[*]:-}" ] && find "${DTYPES_EXIST[@]}" -type f \( -name '*.d.ts' -o -name '*.d.mts' \) -delete
  for d in "${DTYPES_EXIST[@]:-}"; do
    find "$d" -type d -name '@types' -prune -exec rm -rf {} + 2>/dev/null || true
  done
  record "TS 声明 (.d.ts/@types)" "$((DTS_BYTES + ATYPES_BYTES))"
fi

# ---------------------------------------------------------------------------
# 3. monaco-editor npm 包（前端用 public/monaco 自托管，运行时不引用）
# ---------------------------------------------------------------------------
MONACO_DIR="$PKG/app/node_modules/monaco-editor"
if [ -d "$MONACO_DIR" ]; then
  MONACO_BYTES="$(size_of "$MONACO_DIR")"
  if [ "$DRY_RUN" = "1" ]; then
    record "monaco-editor 整包" "$MONACO_BYTES"
  else
    rm -rf "$MONACO_DIR"
    record "monaco-editor 整包" "$MONACO_BYTES"
  fi
fi

# ---------------------------------------------------------------------------
# 3b. sharp/libvips：Next 的图片优化器可选后端。
#     next.config.ts 已设置 images.unoptimized=true（前端只用静态 logo），
#     sharp 只保留在 Next 的 optional dependency 里，运行时不加载。
#     移除 sharp + @img/sharp-* + @img/colour 可避免随包分发 LGPL 的
#     libvips（@img/sharp-libvips-*）以及 sharp 的攻击面。
#     如果以后启用 Next 图片优化，必须保留这些包并重新做 LGPL 合规。
# ---------------------------------------------------------------------------
NEXT_CONFIG="$PKG/app/next.config.ts"
SHARP_BYTES=0
if [ -f "$NEXT_CONFIG" ] && grep -Eq 'unoptimized:[[:space:]]*true' "$NEXT_CONFIG"; then
  SHARP_TARGETS=("$PKG/app/node_modules/sharp")
  if [ -d "$PKG/app/node_modules/@img" ]; then
    while IFS= read -r t; do
      [ -n "$t" ] && SHARP_TARGETS+=("$t")
    done < <(find "$PKG/app/node_modules/@img" -maxdepth 1 -type d \
      \( -name 'sharp-*' -o -name 'colour' \) -print 2>/dev/null)
  fi
  for t in "${SHARP_TARGETS[@]}"; do
    [ -e "$t" ] || continue
    b="$(size_of "$t")"
    SHARP_BYTES=$((SHARP_BYTES + b))
    [ "$DRY_RUN" = "1" ] || rm -rf "$t"
  done
  [ "$SHARP_BYTES" -gt 0 ] && record "sharp/libvips (images.unoptimized)" "$SHARP_BYTES"
  if [ "$DRY_RUN" != "1" ]; then
    rmdir "$PKG/app/node_modules/@img" 2>/dev/null || true
  fi
else
  warn "未检测到 next.config.ts 的 images.unoptimized=true，保留 sharp/libvips（需 LGPL 合规）"
fi

# ---------------------------------------------------------------------------
# 4. recheck 可选后端：默认只删 Java JAR + 非 Linux 原生包；Linux 原生包
#    留到 --aggressive（需实际 checkSync 冒烟）。
# ---------------------------------------------------------------------------
RECHECK_PATTERNS=( -type d \( -name 'recheck-jar' \
  -o -name 'recheck-macos-*' -o -name 'recheck-windows-*' \) -prune )
RECHECK_BYTES=0
if [ -d "$PKG/config/pi" ]; then
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    b="$(size_of "$t")"
    RECHECK_BYTES=$((RECHECK_BYTES + b))
    [ "$DRY_RUN" = "1" ] || rm -rf "$t"
  done < <(find "$PKG/config/pi" "${RECHECK_PATTERNS[@]}" 2>/dev/null)
fi
[ "$RECHECK_BYTES" -gt 0 ] && record "recheck jar/非 Linux 原生" "$RECHECK_BYTES"

# ---------------------------------------------------------------------------
# 5. .next 开发残留
# ---------------------------------------------------------------------------
NEXTX_BYTES=0
for d in types trace cache dev; do
  t="$PKG/app/.next/$d"
  [ -e "$t" ] || continue
  b="$(size_of "$t")"
  NEXTX_BYTES=$((NEXTX_BYTES + b))
  [ "$DRY_RUN" = "1" ] || rm -rf "$t"
done
[ "$NEXTX_BYTES" -gt 0 ] && record ".next 开发残留 (types/trace)" "$NEXTX_BYTES"

# 扩展目录内容与 runtime/bin/node 的符号表由发布人手工处理，不自动删除：
# 扩展目录里的 media/test/banner 可能被运行时引用；strip node 失败会损坏可执行文件。

# ---------------------------------------------------------------------------
# 8.（--aggressive）需冒烟验证的项目，默认关闭
#    lucide-react:  仅 2 个 client 组件使用，已全部打进 .next（server bundle
#                   零引用）——删除后需逐页验证图标
#    caniuse-lite:  browserslist 数据库，构建期用；删除后需验证样式正常
#    pi-coding-agent 文档: docs/ examples/ CHANGELOG（vendor/ 绝不可动）
# ---------------------------------------------------------------------------
if [ "$AGGRESSIVE" = "1" ]; then
  LUCIDE_DIR="$PKG/app/node_modules/lucide-react"
  if [ -d "$LUCIDE_DIR" ]; then
    b="$(size_of "$LUCIDE_DIR")"
    [ "$DRY_RUN" = "1" ] || rm -rf "$LUCIDE_DIR"
    record "aggressive: lucide-react (需验证)" "$b"
  fi
  CANIUSE_DIR="$PKG/app/node_modules/caniuse-lite"
  if [ -d "$CANIUSE_DIR" ]; then
    b="$(size_of "$CANIUSE_DIR")"
    [ "$DRY_RUN" = "1" ] || rm -rf "$CANIUSE_DIR"
    record "aggressive: caniuse-lite (需验证)" "$b"
  fi
  # Linux 原生 recheck 后端：只有确认 checkSync 在缺原生包时仍工作才启用。
  if [ -d "$PKG/config/pi" ]; then
    b=0
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      x="$(size_of "$t")"; b=$((b + x))
      [ "$DRY_RUN" = "1" ] || rm -rf "$t"
    done < <(find "$PKG/config/pi" -type d -name 'recheck-linux-*' -prune 2>/dev/null)
    [ "$b" -gt 0 ] && record "aggressive: recheck Linux 原生 (需验证)" "$b"
  fi
  PCA_DIR="$PKG/app/node_modules/@earendil-works/pi-coding-agent"
  if [ -d "$PCA_DIR" ]; then
    b=0
    for t in "$PCA_DIR/docs" "$PCA_DIR/examples"; do
      [ -e "$t" ] || continue
      x="$(size_of "$t")"; b=$((b + x))
      [ "$DRY_RUN" = "1" ] || rm -rf "$t"
    done
    if [ -f "$PCA_DIR/CHANGELOG.md" ]; then
      x="$(stat -c %s "$PCA_DIR/CHANGELOG.md")"; b=$((b + x))
      [ "$DRY_RUN" = "1" ] || rm -f "$PCA_DIR/CHANGELOG.md"
    fi
    [ "$b" -gt 0 ] && record "aggressive: pi-coding-agent 文档 (需验证)" "$b"
  fi
fi

# ---------------------------------------------------------------------------
# 9. 完整性自检：保留项必须在位
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  log "dry-run 结束，未做修改（完整性自检跳过）"
else
  FAIL=0
  check() { # <说明> <测试命令...>
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then
      printf '   \033[1;32mOK\033[0m   %s\n' "$name"
    else
      printf '   \033[1;31mFAIL\033[0m %s\n' "$name"; FAIL=1
    fi
  }
  log "完整性自检（保留项必须在位）"
  check "runtime/bin/node 可执行"            test -x "$PKG/runtime/bin/node"
  check "app/.next/server 存在"              test -d "$PKG/app/.next/server"
  check "public/monaco/vs/loader.js 存在"    test -f "$PKG/app/public/monaco/vs/loader.js"
  if [ -f "$PKG/app/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm.js" ] \
    || [ -f "$PKG/app/node_modules/@next/swc-wasm-nodejs/wasm.js" ]; then
    printf '   \033[1;32mOK\033[0m   %s\n' "next/swc wasm fallback 保留 (glibc<2.29)"
  else
    printf '   \033[1;31mFAIL\033[0m %s\n' "next/swc wasm fallback 缺失（需要 @next/swc-wasm-nodejs/wasm.js）"
    FAIL=1
  fi
  check "@next/swc-linux-x64-gnu 保留"       test -d "$PKG/app/node_modules/@next/swc-linux-x64-gnu"
  if [ -f "$NEXT_CONFIG" ] && grep -Eq 'unoptimized:[[:space:]]*true' "$NEXT_CONFIG"; then
    if [ -e "$PKG/app/node_modules/sharp" ] || [ -e "$PKG/app/node_modules/@img/sharp-linux-x64" ]; then
      printf '   \033[1;31mFAIL\033[0m %s\n' "sharp 未移除（images.unoptimized=true）"
      FAIL=1
    else
      printf '   \033[1;32mOK\033[0m   %s\n' "sharp/libvips 已移除 (images.unoptimized)"
    fi
  else
    check "sharp 绑定保留 (next/image)"      test -d "$PKG/app/node_modules/@img/sharp-linux-x64"
  fi
  check "pi-coding-agent 保留"               test -d "$PKG/app/node_modules/@earendil-works/pi-coding-agent"
  check "pi-coding-agent vendor 保留"        test -d "$PKG/app/node_modules/@earendil-works/pi-coding-agent/vendor"
  [ -d "$PKG/config/pi" ] && check "config/pi 保留" test -d "$PKG/config/pi"
  [ -d "$PKG/runtime/lib/node_modules/npm" ] && check "npm/corepack 保留" test -d "$PKG/runtime/lib/node_modules/npm"
  [ "$FAIL" = "1" ] && die "完整性自检失败——请检查上述缺失项"
fi

# ---------------------------------------------------------------------------
# 10. 报告
# ---------------------------------------------------------------------------
TOTAL_AFTER="$(size_of "$PKG")"
if [ "$DRY_RUN" = "1" ]; then
  SAVED="$SAVED_SUM"
else
  SAVED=$((TOTAL_BEFORE - TOTAL_AFTER))
  [ "$SAVED" -lt 0 ] && SAVED=0
fi
echo
printf '  %-34s %s\n' "步骤" "节省"
printf '  %-34s %s\n' "------------------------------------" "--------"
for line in "${STEPS[@]:-}"; do
  [ -n "$line" ] && printf '  %s\n' "$line"
done
printf '  %-34s %s\n' "------------------------------------" "--------"
if [ "$DRY_RUN" = "1" ]; then
  printf '  %-34s %s\n' "预计节省合计" "$(human "$SAVED")"
  printf '  瘦身前: %s → 预计瘦身后: %s\n' "$(human "$TOTAL_BEFORE")" "$(human $((TOTAL_BEFORE - SAVED)))"
  echo "   （实际执行: 去掉 --dry-run 重跑）"
else
  printf '  %-34s %s\n' "节省合计" "$(human "$SAVED")"
  printf '  瘦身前: %s → 瘦身后: %s\n' "$(human "$TOTAL_BEFORE")" "$(human "$TOTAL_AFTER")"
  echo
  echo "  建议: 用包内冒烟方式复验（pi CLI 存活 + pi-web HTTP 应答），"
  echo "  并浏览器点一遍编辑器/FileViewer（自托管 monaco）、会话页与终端。"
  echo "  扩展目录开发内容与 runtime/bin/node 符号表未自动处理，由发布人手工作业。"
fi
