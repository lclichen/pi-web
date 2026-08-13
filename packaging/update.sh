#!/usr/bin/env bash
#
# update.sh — 检查并更新离线分发包（版本与更新机制）。
#
# 更新源（按优先级）:
#   1. 环境变量 PI_UPDATE_BASE_URL —— 托管 versions.json 的目录
#   2. 包内 config/update-url.txt（构建时由 PI_UPDATE_BASE_URL 写入）
#   3. app/package.json 的 repository 字段推导 GitHub Releases：
#        <repo>/releases/latest/download/versions.json
#      （GitHub 的 latest/download 会自动重定向到最新 Release 的该 asset）
#
# versions.json 约定（发布时生成，见 .github/workflows/package-linux.yml）:
#   { "version":"0.0.2.alpha", "date":"2026-08-06",
#     "url":"https://.../pi-linux-x64-0.0.2.alpha.tar.gz",
#     "sha256":"...", "notes":"更新说明" }
#
# 版本号规则: 点分数字段 + 可选字符串后缀（如 0.0.1.alpha < 0.0.2.alpha），
# 逐段比较，首个不同的段决定大小；数字段按数值比较。
#
# 用法:
#   ./scripts/update.sh           检查；有新版则询问后更新
#   ./scripts/update.sh --check   只检查（有新版退出码 2，已最新退出码 0）
#   ./scripts/update.sh --yes     有新版直接更新，不询问
#
# 退出码: 0 = 已最新或更新完成；2 = 有新版（--check 时）；1 = 出错
#
# 注意:
#   * 更新只替换包目录本身；用户数据都在 ~/.pi/（agent 目录），在包外，
#     不受影响。
#   * 需要能访问更新源，且对包所在目录有写权限。
#   * GitHub 的 latest 重定向不指向预发布（alpha/beta 若标为 prerelease），
#     此时请用 PI_UPDATE_BASE_URL 指定具体地址，例如:
#       PI_UPDATE_BASE_URL=https://github.com/OWNER/REPO/releases/download/v0.0.2.alpha \
#         ./scripts/update.sh
set -euo pipefail

# 解析脚本真实路径（支持通过软链调用）
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  TARGET="$(readlink "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *)  SOURCE="$(dirname "$SOURCE")/$TARGET" ;;
  esac
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
# 本脚本位于包内 scripts/ 子目录: ROOT 是包根，PARENT 是包所在目录
# （原子交换要把整个包目录改名，CWD 必须先离开包目录）
ROOT="$(dirname "$DIR")"
PARENT="$(dirname "$ROOT")"
cd "$PARENT"
NODE="$ROOT/runtime/bin/node"
CUR_VER="$(cat "$DIR/VERSION.txt" 2>/dev/null || echo "unknown")"
CHECK=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --yes)   YES=1 ;;
    *) echo "未知参数: $arg（支持 --check / --yes）" >&2; exit 2 ;;
  esac
done

log() { echo "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ -x "$NODE" ] || die "未找到内置 Node 运行时（$NODE）"

# ---- 1. 确定更新源 ----
BASE="${PI_UPDATE_BASE_URL:-$(cat "$ROOT/config/update-url.txt" 2>/dev/null || true)}"
if [ -z "$BASE" ]; then
  REPO_URL="$("$NODE" -e 'console.log(require(process.argv[1]).repository?.url || "")' "$ROOT/app/package.json" 2>/dev/null || true)"
  REPO_URL="$(printf '%s' "$REPO_URL" | sed -E 's#^(git\+|git@github.com:)?##; s#\.git$##')"
  case "$REPO_URL" in
    https://github.com/*) BASE="${REPO_URL%/}/releases/latest/download" ;;
    *) die "未配置更新源。请用环境变量 PI_UPDATE_BASE_URL 指定托管 versions.json 的目录，或在打包时写入 config/update-url.txt。" ;;
  esac
fi
MANIFEST_URL="${BASE%/}/versions.json"
log "更新源: $BASE"

# ---- 2. 获取并解析更新清单 ----
TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-update.XXXXXX")"
trap 'rm -rf "$TMPDIR"' EXIT
MANIFEST="$TMPDIR/versions.json"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$MANIFEST_URL" -o "$MANIFEST" \
    || die "无法获取更新清单: $MANIFEST_URL（若发布的是 GitHub 预发布/alpha，latest 重定向不会指向它，请用 PI_UPDATE_BASE_URL 指定具体地址）"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$MANIFEST" "$MANIFEST_URL" \
    || die "无法获取更新清单: $MANIFEST_URL（若发布的是 GitHub 预发布/alpha，latest 重定向不会指向它，请用 PI_UPDATE_BASE_URL 指定具体地址）"
else
  die "需要 curl 或 wget 来检查更新"
fi

LATEST_VER="$(  "$NODE" -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(m.version||"")' "$MANIFEST")"
LATEST_URL="$(  "$NODE" -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(m.url||"")' "$MANIFEST")"
LATEST_SHA="$(  "$NODE" -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(m.sha256||"")' "$MANIFEST")"
LATEST_NOTES="$("$NODE" -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(m.notes||"")' "$MANIFEST")"
[ -n "$LATEST_VER" ] || die "versions.json 缺少 version 字段: $MANIFEST_URL"

# ---- 3. 版本比较 ----
newer() { # a b → 退出码 0 表示 b 比 a 新
  [ "$1" = "$2" ] && return 1
  "$NODE" -e '
    function cmp(a, b) {
      const pa = a.split(/[.-]+/), pb = b.split(/[.-]+/);
      const n = Math.max(pa.length, pb.length);
      for (let i = 0; i < n; i++) {
        const x = pa[i] ?? "", y = pb[i] ?? "";
        if (x === y) continue;
        const nx = Number(x), ny = Number(y);
        const xn = !isNaN(nx) && x !== "", yn = !isNaN(ny) && y !== "";
        if (xn && yn) { if (nx !== ny) return nx > ny ? 1 : -1; continue; }
        if (xn) return 1;   // 数字段大于字符串段，如 "1.0" < "1.0.1"
        if (yn) return -1;
        if (x > y) return 1;
        if (x < y) return -1;
      }
      return 0;
    }
    process.exit(cmp(process.argv[2], process.argv[1]) > 0 ? 0 : 1);
  ' "$1" "$2"
}

if newer "$CUR_VER" "$LATEST_VER"; then
  log "发现新版本: v$CUR_VER → v$LATEST_VER"
  [ -n "$LATEST_NOTES" ] && log "更新说明: $LATEST_NOTES"
else
  log "当前已是最新版本: v$CUR_VER"
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  exit 2
fi

[ -n "$LATEST_URL" ] || die "versions.json 缺少 url 字段"
if [ "$YES" != "1" ]; then
  printf "是否下载并更新？[y/N] "
  read -r ans || true
  case "$ans" in
    y|Y|yes|YES) ;;
    *) log "已取消。"; exit 0 ;;
  esac
fi

# ---- 4. 下载 + SHA256 校验 ----
PKG_FILE="$TMPDIR/pi-linux-$LATEST_VER.tar.gz"
log "下载: $LATEST_URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$LATEST_URL" -o "$PKG_FILE" || die "下载失败: $LATEST_URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$PKG_FILE" "$LATEST_URL" || die "下载失败: $LATEST_URL"
fi

if [ -n "$LATEST_SHA" ]; then
  GOT_SHA="$("$NODE" -e 'const fs=require("fs"),c=require("crypto"); console.log(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$PKG_FILE")"
  if [ "$GOT_SHA" != "$LATEST_SHA" ]; then
    die "SHA256 校验失败: 期望 $LATEST_SHA，实际 $GOT_SHA（下载可能被篡改或损坏，已中止）"
  fi
  log "SHA256 校验通过"
else
  log "警告: versions.json 未提供 sha256，跳过校验"
fi

# ---- 5. 解压 + 原子替换 ----
NEW_DIR="$TMPDIR/new"
mkdir -p "$NEW_DIR"
tar -xzf "$PKG_FILE" -C "$NEW_DIR" --strip-components=1 || die "解压失败（压缩包可能损坏）"
[ -x "$NEW_DIR/pi" ] && [ -x "$NEW_DIR/pi-web.sh" ] && [ -x "$NEW_DIR/runtime/bin/node" ] \
  || die "下载的包结构不完整（缺少 pi / pi-web.sh / runtime/bin/node），已中止"

# 用户可能自定义过 config/update-url.txt（环境变量只影响本次运行），保留它
if [ -f "$ROOT/config/update-url.txt" ] && [ ! -f "$NEW_DIR/config/update-url.txt" ]; then
  cp -a "$ROOT/config/update-url.txt" "$NEW_DIR/config/update-url.txt"
fi

CUR_NAME="$(basename "$ROOT")"
OLD_DIR="$PARENT/.$CUR_NAME.old"
rm -rf "$OLD_DIR"
log "替换包目录（用户数据在 ~/.pi，不受影响）..."
mv "$ROOT" "$OLD_DIR" || die "无法移动当前目录（对包所在目录 $PARENT 没有写权限？）"
if ! mv "$NEW_DIR" "$ROOT"; then
  mv "$OLD_DIR" "$ROOT" || true
  die "替换失败，已回滚"
fi
rm -rf "$OLD_DIR"

echo
echo "更新完成: v$CUR_VER → v$LATEST_VER"
echo "新版本目录仍在 $ROOT，启动器（./pi、./pi-web.sh、./scripts/start.sh）照常使用。"
echo "提示: 新包若带更新版本的配置模板（config/pi），下次启动时会自动合并。"
