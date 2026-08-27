#!/usr/bin/env bash
#
# package-linux.sh — 构建 pi-web + pi CLI Agent 的 Linux 离线分发包。
#
# 产物（目录 + 压缩包）:
#   dist/amedac.ai-pi-linux-<arch>-<version>.tar.gz   (+ SHA256SUMS)
#   build/package-linux/amedac.ai-pi-linux-<arch>/    原始目录，可直接拷贝分发
#
# 用法:
#   bash scripts/package-linux.sh
#
# 环境变量（全部可选）:
#   PI_CODING_AGENT_LOCAL  本地编译的 pi-coding-agent 安装包的路径或 URL：
#                          - 一个 .tgz 压缩包
#                          - 一个已解压的目录（含 package.json）
#                          - 一个 https:// URL（适合 CI 里指向内网/私有源）
#                          设置后，它会在 `next build` 之前替换掉 registry 版本，
#                          并随包进入最终产物，运行时使用本地编译的 SDK。
#                          示例:
#                            PI_CODING_AGENT_LOCAL=/data/pi-coding-agent-0.83.1.tgz
#                            PI_CODING_AGENT_LOCAL=/data/pi-coding-agent-src
#                            PI_CODING_AGENT_LOCAL=https://intranet/pi-coding-agent.tgz
#   NODE_RUNTIME_LOCAL    内置 Node.js 运行时的本地来源，用于不访问 nodejs.org 的
#                         分发场景（优先级最高；设置后既不下载也不复用旧 runtime）:
#                          - 一个 .tar.gz / .tar.xz 包（nodejs.org 官方同格式）
#                          - 一个已解压的目录（node-v*-linux-*/ 或 runtime/ 布局）
#                          - 一个 http(s):// URL（内网镜像）
#                         示例:
#                            NODE_RUNTIME_LOCAL=/data/node-v22.23.0-linux-x64.tar.gz
#                            NODE_RUNTIME_LOCAL=/data/node-v22.23.0-linux-x64
#                            NODE_RUNTIME_LOCAL=https://mirror.internal/node-v22.23.0-linux-x64.tar.gz
#   PI_CONFIG_DIR         要随包分发的 pi 配置模板目录（pi 扩展、模型接口配置等
#                         的规范分发）。指向 ~/.pi 或 ~/.pi/agent 均可（自动识别）。
#                         打包进包内 config/pi/，目标机首次运行时由
#                         packaging/install-pi-config.sh 合并到 ~/.pi/agent。
#                         打包时会排除 sessions/、auth.json、bin/、tmp/ 等
#                         用户数据与敏感文件。默认: <仓库>/pi-config（不存在则跳过）。
#   PI_CONFIG_VERSION     配置模板版本号 (默认: 1)。发布新版包时递增，目标机
#                         据此做配置的增量更新（见 packaging/install-pi-config.sh）。
#   PI_EXTENSIONS         空格分隔的本地扩展目录列表（每个必须是含 package.json
#                         的扩展包）。打包时在构建机执行 npm install --omit=dev
#                         预装依赖，把整个目录（含 node_modules）拷进包内
#                         config/pi/extensions/<目录名>/ —— 目标机安装后位于
#                         ~/.pi/agent/extensions/<目录名>/，pi 启动时自动发现
#                         加载（入口须为 index.ts/index.js，或 package.json 的
#                         pi.extensions），依赖从扩展自带 node_modules 解析，
#                         完全离线、无需再装依赖。相对路径按仓库根目录解析；
#                         目录名冲突会报错。
#   PI_BINARIES           空格分隔的本地二进制文件路径（如 fd、rg 的 Linux
#                         版本，架构须与 ARCH 一致）。拷入包内 bin/，目标机
#                         pi / pi-web.sh 启动时自动把该目录加进 PATH，
#                         pi 的 bash 工具里即可直接调用（如 fd / rg）。
#   PI_UPDATE_BASE_URL    更新源目录（托管 versions.json）。写入包内
#                         config/update-url.txt，目标机用 ./update.sh 检查更新。
#                         未设置时 update.sh 尝试从 app/package.json 的
#                         repository 字段推导 GitHub Releases 地址。
#   NODE_VERSION          内置 Node.js 运行时版本 (默认: 22.23.0；仅当未设置
#                         NODE_RUNTIME_LOCAL 时用于从 nodejs.org 下载)
#   ARCH                  目标 CPU 架构: x64 | arm64 (默认: x64)
#   OUT_DIR               产物输出目录 (默认: <仓库>/dist)
#   SMOKE_TEST            设为 "0" 跳过构建后的冒烟测试 (默认: 1)
#   SKIP_RUNTIME_DOWNLOAD 设为 "1" 复用包内已有的 runtime/，不再下载 Node
#                         （构建机完全离线时使用；NODE_RUNTIME_LOCAL 优先级更高）
#
# 沙盒教学平台（可选组件）:
#   WITH_SANDBOX          "1"=打包沙盒平台全家桶，"0"=不打包；
#                         默认自动：找得到 sandbox-platform 源码就打包。
#                         打包内容（包内 sandbox/ 目录 + 一键脚本）:
#                           sandbox/platform/    容器管理 API（sqlite 零依赖部署，
#                                                启动自动迁移，端口默认 3000）
#                           sandbox/extension/   pi-sandbox-extension 桥接扩展
#                           scripts/start-all.sh 一键启动 平台+WebUI（首次运行自动
#                                                生成 env、数据落在 data/）
#                           scripts/stop-all.sh / status-all.sh
#                         目标机还要求安装 Apptainer（容器执行器），脚本会检测并提示。
#   SANDBOX_PLATFORM_DIR     sandbox-platform 仓库路径。默认依次探测:
#                            ../sandbox-platform、../../AgentSandbox/sandbox-platform
#   SANDBOX_EXTENSION_DIR    pi-sandbox-extension 仓库路径。默认探测: ../pi-sandbox-extension
#
# 构建机要求: Linux（或 WSL）、bash、curl（或 wget）、tar、Node.js >= 22
#            （用于安装依赖和执行 next build；产物本身不需要）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/build/package-linux"
SRC="$WORK/src"
ARCH="${ARCH:-x64}"
NODE_VERSION="${NODE_VERSION:-22.23.0}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
SMOKE_TEST="${SMOKE_TEST:-1}"
LOCAL="${PI_CODING_AGENT_LOCAL:-}"
# pi 配置模板默认取仓库内 pi-config/ 目录（未显式指定且目录不存在时静默跳过）
PI_CONFIG_DIR_EXPLICIT="${PI_CONFIG_DIR+set}"
PI_CONFIG_DIR="${PI_CONFIG_DIR:-$ROOT/pi-config}"

log() { printf '\033[1;32m>>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. 构建机前置检查
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "PATH 中没有 node（构建需要 Node >= 22，产物不需要）"
node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' \
  || die "构建机需要 Node >= 22（当前 $(node -v)）"
command -v tar >/dev/null 2>&1 || die "PATH 中没有 tar"

rm -rf "$WORK"
mkdir -p "$WORK" "$OUT_DIR"

# ---------------------------------------------------------------------------
# 1. 把仓库复制到一次性工作目录（保持源树干净：不动 node_modules/.next/.git）
# ---------------------------------------------------------------------------
log "复制源码到 $SRC（排除 node_modules/.next/.git/build/dist）"
mkdir -p "$SRC"
(cd "$ROOT" && tar --exclude='./node_modules' --exclude='./.next' --exclude='./.git' \
  --exclude='./build' --exclude='./dist' -cf - .) | (cd "$SRC" && tar -xf -)

# ---------------------------------------------------------------------------
# 2. 安装依赖（完整安装，next build 需要 devDependencies）
# ---------------------------------------------------------------------------
log "npm ci"
(cd "$SRC" && npm ci --no-audit --no-fund)

# ---------------------------------------------------------------------------
# 3.（可选）替换为本地编译的 pi-coding-agent
#    通过把依赖改成 file: 说明符再 npm install，package.json 与 lockfile 同步，
#    后续 prune/build 都不会把它回退成 registry 版本。
# ---------------------------------------------------------------------------
if [ -n "$LOCAL" ]; then
  case "$LOCAL" in
    http://*|https://*)
      SPEC="$LOCAL" ;;
    *)
      [ -e "$LOCAL" ] || die "PI_CODING_AGENT_LOCAL 不存在: $LOCAL"
      SPEC="file:$(cd "$(dirname "$LOCAL")" && pwd)/$(basename "$LOCAL")"
      ;;
  esac
  log "使用本地 pi-coding-agent: $LOCAL"
  (cd "$SRC" && npm pkg set "dependencies.@earendil-works/pi-coding-agent=$SPEC")
  (cd "$SRC" && npm install --no-audit --no-fund)
fi
# (cd "$SRC" && node -e 'console.log("   pi-coding-agent ->", require("@earendil-works/pi-coding-agent/package.json").version)')

# ---------------------------------------------------------------------------
# 4. 生产构建
# ---------------------------------------------------------------------------
log "npm run build（next build --webpack）"
(cd "$SRC" && npm run build)

# ---------------------------------------------------------------------------
# 5. 只保留生产依赖
# ---------------------------------------------------------------------------
log "npm prune --omit=dev"
(cd "$SRC" && npm prune --omit=dev --no-audit --no-fund)
if [ -n "$LOCAL" ]; then
  # 把 shipped package.json 里的 file: 说明符还原成具体版本号，保持整洁
  LOCAL_VER="0.83.0"
  # "$(cd "$SRC" && node -p 'require("@earendil-works/pi-coding-agent/package.json").version')"
  (cd "$SRC" && npm pkg set "dependencies.@earendil-works/pi-coding-agent=$LOCAL_VER")
fi

# ---------------------------------------------------------------------------
# 6. 清理 .next 里的开发产物
# ---------------------------------------------------------------------------
log "清理 .next（dev 缓存与 source map）"
rm -rf "$SRC/.next/dev" "$SRC/.next/cache"
find "$SRC/.next" -name '*.map' -type f -delete

# ---------------------------------------------------------------------------
# 7. 组装包目录
# ---------------------------------------------------------------------------
PKG="$WORK/amedac.ai-pi-linux-$ARCH"
rm -rf "$PKG"
mkdir -p "$PKG/app"
log "组装 $PKG"
cp -a "$SRC/bin" "$SRC/.next" "$SRC/public" "$SRC/next.config.ts" "$SRC/package.json" "$PKG/app/"
cp -a "$SRC/node_modules" "$PKG/app/"
VERSION="$(node -p "require('$SRC/package.json').version")"

# 根目录只保留 pi / pi-web.sh 两个启动器；其余脚本与文档统一收进 scripts/
# （start.sh / update.sh / install-to-path.sh / install-pi-config.sh /
#   open-pi-terminal.sh / README.txt / VERSION.txt 等）
mkdir -p "$PKG/scripts"
for f in "$ROOT"/packaging/*; do
  case "$(basename "$f")" in
    pi|pi-web.sh) cp -a "$f" "$PKG/" ;;
    *)            cp -a "$f" "$PKG/scripts/" ;;
  esac
done
echo "$VERSION" > "$PKG/scripts/VERSION.txt"
chmod +x "$PKG/pi" "$PKG/pi-web.sh" "$PKG/scripts/"*.sh

# ---------------------------------------------------------------------------
# 7b. 打包 pi 配置模板（扩展/模型接口等配置的规范分发）
#     PI_CONFIG_DIR 指向一个 .pi 目录（或其 agent/ 子目录，自动识别），
#     打包成 config/pi/；目标机首次运行时由 install-pi-config.sh 合并到
#     ~/.pi/agent。打包时排除会话、凭证、托管二进制与临时文件。
# ---------------------------------------------------------------------------
if [ -d "$PI_CONFIG_DIR" ]; then
  if [ -d "$PI_CONFIG_DIR/agent" ]; then
    CFG_SRC="$PI_CONFIG_DIR/agent"     # 用户指向整个 ~/.pi
  else
    CFG_SRC="$PI_CONFIG_DIR"           # 用户指向 agent 目录本身
  fi
  [ -d "$CFG_SRC" ] || die "PI_CONFIG_DIR 中未找到配置目录: $CFG_SRC"
  log "打包 pi 配置模板: $CFG_SRC"
  mkdir -p "$PKG/config/pi"
  (cd "$CFG_SRC" && tar --exclude='./sessions' --exclude='./auth.json' \
    --exclude='./bin' --exclude='./tmp' --exclude='./pi-debug.log' \
    --exclude='./.bundle-version' --exclude='./.bundle-backup' --exclude='./.gitkeep' \
    -cf - .) | (cd "$PKG/config/pi" && tar -xf -)
  PI_CONFIG_VERSION="${PI_CONFIG_VERSION:-1}"
  echo "$PI_CONFIG_VERSION" > "$PKG/config/pi/.bundle-version"
  log "配置模板版本: $PI_CONFIG_VERSION"
elif [ -n "$PI_CONFIG_DIR_EXPLICIT" ] && [ -n "$PI_CONFIG_DIR" ] && [ ! -e "$PI_CONFIG_DIR" ]; then
  die "PI_CONFIG_DIR 不存在: $PI_CONFIG_DIR"
fi

# ---------------------------------------------------------------------------
# 7c.（可选）把本地扩展（文件夹，需 npm 安装依赖）打进配置模板
#     对 PI_EXTENSIONS 里的每个扩展目录: 构建机先 npm install --omit=dev 预装
#     依赖，再连同 node_modules 整体拷入 config/pi/extensions/<目录名>/。
#     目标机安装后位于 ~/.pi/agent/extensions/<目录名>/，pi 启动时自动发现
#     加载（index.ts / index.js 入口，或 package.json 的 pi.extensions），
#     依赖从扩展自带 node_modules 解析 —— 完全离线，无需写入 settings.json。
# ---------------------------------------------------------------------------
if [ -n "${PI_EXTENSIONS:-}" ]; then
  [ -d "$PKG/config/pi" ] || mkdir -p "$PKG/config/pi"
  for p in $PI_EXTENSIONS; do
    case "$p" in
      /*) EXT_DIR="$p" ;;
      *)  EXT_DIR="$ROOT/$p" ;;
    esac
    [ -d "$EXT_DIR" ] || die "PI_EXTENSIONS 中的扩展目录不存在: $p"
    [ -f "$EXT_DIR/package.json" ] || die "扩展目录缺少 package.json: $p"
    # 扩展必须能被 pi 自动发现（collectAutoExtensionEntries）: 有
    # index.ts/index.js 入口，或 package.json 的 pi.extensions 指向存在的文件
    if [ ! -f "$EXT_DIR/index.ts" ] && [ ! -f "$EXT_DIR/index.js" ]; then
      if ! node -e 'const fs=require("fs"),path=require("path");const d=process.argv[1];const p=JSON.parse(fs.readFileSync(path.join(d,"package.json"),"utf8"));for(const e of (p.pi&&p.pi.extensions)||[]){if(fs.existsSync(path.join(d,e)))process.exit(0)}process.exit(1)' "$EXT_DIR" >/dev/null 2>&1; then
        die "扩展入口无法被 pi 自动发现: $p（需 index.ts/index.js，或在 package.json 加 pi.extensions）"
      fi
    fi
    NAME="$(basename "$EXT_DIR")"
    log "打包本地扩展: $EXT_DIR -> config/pi/extensions/$NAME"
    (cd "$EXT_DIR" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund)
    mkdir -p "$PKG/config/pi/extensions"
    [ -e "$PKG/config/pi/extensions/$NAME" ] \
      && die "扩展目录名冲突: $NAME（PI_EXTENSIONS 里的目录名必须唯一，且不能与已有扩展同名）"
    cp -a "$EXT_DIR" "$PKG/config/pi/extensions/$NAME"
  done
  # 仅扩展而配置模板未打包时，补一个配置模板版本标记
  [ -f "$PKG/config/pi/.bundle-version" ] \
    || echo "${PI_CONFIG_VERSION:-1}" > "$PKG/config/pi/.bundle-version"
fi
if [ -n "${PI_UPDATE_BASE_URL:-}" ]; then
  mkdir -p "$PKG/config"
  printf '%s\n' "$PI_UPDATE_BASE_URL" > "$PKG/config/update-url.txt"
  log "更新源: $PI_UPDATE_BASE_URL"
fi

# ---------------------------------------------------------------------------
# 7d. 沙盒教学平台组件（可选）：sandbox-platform + pi-sandbox-extension
#     打进 sandbox/，配套 scripts/start-all.sh 一键启动平台+WebUI。
# ---------------------------------------------------------------------------
find_repo_dir() { # <说明> <默认候选...> -> 打印第一个存在的目录
  local desc="$1"; shift
  for c in "$@"; do
    if [ -d "$c" ] && [ -f "$c/package.json" ]; then
      (cd "$c" && pwd)
      return 0
    fi
  done
  return 1
}

SANDOX_WANTED="${WITH_SANDBOX:-}"
SANDBOX_PLATFORM_SRC="${SANDBOX_PLATFORM_DIR:-}"
SANDBOX_EXTENSION_SRC="${SANDBOX_EXTENSION_DIR:-}"

AUTO_PLATFORM="$(find_repo_dir sandbox-platform "$ROOT/../sandbox-platform" "$ROOT/../../AgentSandbox/sandbox-platform" || true)"
AUTO_EXTENSION="$(find_repo_dir pi-sandbox-extension "$ROOT/../pi-sandbox-extension" "$ROOT/../../LabTrainingProject/pi-sandbox-extension" || true)"

if [ -z "$SANDOX_WANTED" ]; then
  # 自动模式：两个源都找齐才打包
  [ -n "$SANDBOX_PLATFORM_SRC" ] || SANDBOX_PLATFORM_SRC="$AUTO_PLATFORM"
  [ -n "$SANDBOX_EXTENSION_SRC" ] || SANDBOX_EXTENSION_SRC="$AUTO_EXTENSION"
  WITH_SANDBOX=1
  [ -d "$SANDBOX_PLATFORM_SRC" ] && [ -d "$SANDBOX_EXTENSION_SRC" ] || WITH_SANDBOX=0
elif [ "$SANDOX_WANTED" = "1" ]; then
  [ -d "$SANDBOX_PLATFORM_SRC" ] || SANDBOX_PLATFORM_SRC="$AUTO_PLATFORM"
  [ -d "$SANDBOX_EXTENSION_SRC" ] || SANDBOX_EXTENSION_SRC="$AUTO_EXTENSION"
  [ -d "$SANDBOX_PLATFORM_SRC" ] || die "WITH_SANDBOX=1 但找不到 sandbox-platform（设 SANDBOX_PLATFORM_DIR=/路径）"
  [ -d "$SANDBOX_EXTENSION_SRC" ] || die "WITH_SANDBOX=1 但找不到 pi-sandbox-extension（设 SANDBOX_EXTENSION_DIR=/路径）"
else
  WITH_SANDBOX=0
fi

if [ "$WITH_SANDBOX" = "1" ]; then
  log "沙盒教学平台组件: 打包"
  SBX="$PKG/sandbox"

  # 平台：整树拷贝（.ts 直接以 Node 类型剥离运行，无构建步骤），装生产依赖
  log "打包 sandbox-platform: $SANDBOX_PLATFORM_SRC -> sandbox/platform"
  mkdir -p "$SBX/platform"
  (cd "$SANDBOX_PLATFORM_SRC" && tar \
    --exclude='./.git' --exclude='./node_modules' --exclude='./data' \
    --exclude='./logs' --exclude='*.log' --exclude='./web' --exclude='./dist' \
    -cf - .) | (cd "$SBX/platform" && tar -xf -)
  (cd "$SBX/platform" && npm ci --no-audit --no-fund)
  # 运行入口是 node --experimental-transform-types src/index.ts，只吃运行时依赖
  (cd "$SBX/platform" && npm prune --omit=dev --no-audit --no-fund)
  PLATFORM_VERSION="$(node -p "require('$SBX/platform/package.json').version")"
  echo "$PLATFORM_VERSION" > "$SBX/platform/.shipped-version"
  log "sandbox-platform 版本: $PLATFORM_VERSION"

  # 扩展：pi-sandbox-extension（自带 node_modules 离线可用）
  log "打包 pi-sandbox-extension: $SANDBOX_EXTENSION_SRC -> sandbox/extension"
  mkdir -p "$SBX/extension"
  (cd "$SANDBOX_EXTENSION_SRC" && tar \
    --exclude='./.git' --exclude='./node_modules' --exclude='./data' \
    --exclude='*.log' -cf - .) | (cd "$SBX/extension" && tar -xf -)
  (cd "$SBX/extension" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund)

  # 首次部署说明落在包内
  cat > "$SBX/README.txt" <<'EOF'
沙盒教学平台组件
================
sandbox/platform/   容器管理 API —— sqlite 存储、启动自动迁移、默认
                    监听 127.0.0.1:3000（管理控制台静态页未随包分发）。
sandbox/extension/  pi 的沙盒桥接扩展（bash/read/write 工具走容器 API）。
                    pi-web 通过 PI_WEB_SANDBOX_EXTENSION_PATH 加载它。

一键使用（在包根目录）:
  ./scripts/start-all.sh    启动 沙盒平台 + WebUI（幂等；首次运行自动生成
                            sandbox/platform.env、sandbox/piweb.env，
                            数据与数据库写入 data/）
  ./scripts/status-all.sh   服务状态 / 日志位置 / apptainer 检测
  ./scripts/stop-all.sh     停止全部

目标机要求: 安装 Apptainer（https://apptainer.org）—— 容器执行器；
未安装时 WebUI 可用，但无法创建/启动沙箱容器。

配置文件（可在 start-all.sh 生成的默认值上修改）:
  sandbox/platform.env   平台端口 / sqlite 路径 / JWT 密钥 / 管理员账号 /
                         EXECUTOR_KIND（apptainer-cli | ssh | mock）
  sandbox/piweb.env      WebUI 认证开关 / 平台地址 / 数据目录 / 扩展路径
EOF
  log "已写入 sandbox/README.txt"
else
  log "沙盒教学平台组件: 不打包（WITH_SANDBOX=$WITH_SANDBOX）"
fi

# ---------------------------------------------------------------------------
# 8. 内置 Node.js 运行时
#    优先级: NODE_RUNTIME_LOCAL（本地包/目录/URL）> SKIP_RUNTIME_DOWNLOAD 复用
#           已有 runtime/ > 从 nodejs.org 下载
# ---------------------------------------------------------------------------
if [ -n "${NODE_RUNTIME_LOCAL:-}" ]; then
  LOCAL_RT="$NODE_RUNTIME_LOCAL"
  case "$LOCAL_RT" in
    http://*|https://*)
      log "获取 Node 运行时 (URL): $LOCAL_RT"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$LOCAL_RT" -o "$WORK/node-local.tar.gz"
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$WORK/node-local.tar.gz" "$LOCAL_RT"
      else
        die "需要 curl 或 wget 来获取 Node 运行时"
      fi
      LOCAL_RT="$WORK/node-local.tar.gz"
      ;;
  esac

  if [ -d "$LOCAL_RT" ]; then
    # 目录: 已解压的 node-v*-linux-*/ 目录，或直接是 runtime/ 布局
    log "使用本地 Node 运行时目录: $LOCAL_RT"
    if [ -x "$LOCAL_RT/bin/node" ]; then
      RT_SRC="$LOCAL_RT"
    elif [ -x "$LOCAL_RT/runtime/bin/node" ]; then
      RT_SRC="$LOCAL_RT/runtime"
    else
      die "NODE_RUNTIME_LOCAL 目录中未找到 bin/node: $LOCAL_RT"
    fi
    rm -rf "$PKG/runtime"
    mkdir -p "$PKG/runtime"
    cp -a "$RT_SRC/." "$PKG/runtime/"
  else
    [ -f "$LOCAL_RT" ] || die "NODE_RUNTIME_LOCAL 不存在: $LOCAL_RT"
    log "使用本地 Node 运行时包: $LOCAL_RT"
    case "$LOCAL_RT" in
      *.tar.xz) tar -xJf "$LOCAL_RT" -C "$WORK" ;;
      *)        tar -xzf "$LOCAL_RT" -C "$WORK" ;;
    esac
    # 找到解压结果中的 bin/node（兼容 node-v*-linux-*/ 或任意自定义布局）
    RT_BIN="$(find "$WORK" -maxdepth 4 -path '*/bin/node' -type f 2>/dev/null | head -n 1)"
    [ -n "$RT_BIN" ] || die "本地 Node 包解压后未找到 bin/node: $LOCAL_RT"
    rm -rf "$PKG/runtime"
    mkdir -p "$PKG/runtime"
    cp -a "$(dirname "$(dirname "$RT_BIN")")/." "$PKG/runtime/"
  fi
elif [ "${SKIP_RUNTIME_DOWNLOAD:-0}" = "1" ] && [ -d "$PKG/runtime" ]; then
  log "复用已有 runtime/（$("$PKG/runtime/bin/node" -v 2>/dev/null || echo '未知版本')）"
else
  URL="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.gz"
  log "下载 Node $NODE_VERSION ($ARCH): $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$WORK/node.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$WORK/node.tar.gz" "$URL"
  else
    die "需要 curl 或 wget 来下载 Node 运行时"
  fi
  tar -xzf "$WORK/node.tar.gz" -C "$WORK"
  rm -rf "$PKG/runtime"
  mkdir -p "$PKG/runtime"
  cp -a "$WORK/node-v$NODE_VERSION-linux-$ARCH/." "$PKG/runtime/"
fi

# 版本核对（无法在本机执行时跳过，例如交叉架构构建）
if [ -x "$PKG/runtime/bin/node" ] && RT_VER="$("$PKG/runtime/bin/node" -v 2>/dev/null)"; then
  log "内置 Node 版本: $RT_VER"
  RT_MAJOR="${RT_VER#v}"
  RT_MAJOR="${RT_MAJOR%%.*}"
  if [ "${RT_MAJOR:-0}" -lt 22 ] 2>/dev/null; then
    log "警告: pi-web 要求 Node >= 22.23.0，当前内置 $RT_VER"
  fi
fi

# ---------------------------------------------------------------------------
# 8b.（可选）附带 CLI 工具（fd / rg 等）
#     PI_BINARIES 是空格分隔的本地二进制文件路径（Linux 版本，架构须与
#     ARCH 一致；构建机若是其他系统不影响，拷入后目标机直接可执行）。
#     拷入包内 bin/，pi / pi-web.sh 启动时自动把该目录加进 PATH。
# ---------------------------------------------------------------------------
if [ -n "${PI_BINARIES:-}" ]; then
  mkdir -p "$PKG/bin"
  for b in $PI_BINARIES; do
    [ -f "$b" ] || die "PI_BINARIES 中的二进制文件不存在: $b"
    cp -a "$b" "$PKG/bin/"
    chmod +x "$PKG/bin/$(basename "$b")"
    log "附带 CLI 工具: $(basename "$b")（$(du -h "$b" | cut -f1)，请确认与目标架构 $ARCH 匹配）"
  done
fi

# ---------------------------------------------------------------------------
# 9. 冒烟测试（产物必须能启动）
# ---------------------------------------------------------------------------
if [ "$SMOKE_TEST" != "0" ]; then
  log "冒烟测试"
  # 用隔离的 HOME 运行，避免 pi / pi-web（含配置模板合并）写构建机的真实 ~/.pi
  SMOKE_HOME="$WORK/smoke-home"
  mkdir -p "$SMOKE_HOME"
  if ! "$PKG/runtime/bin/node" -e 'process.exit(0)' >/dev/null 2>&1; then
    echo "   内置 Node 无法在本机执行（交叉架构构建？），自动跳过冒烟测试"
    echo "   （如确需冒烟测试，请在目标架构的机器上构建，或显式设置 SMOKE_TEST=0）"
    SMOKE_TEST=0
  fi
fi
if [ "$SMOKE_TEST" != "0" ]; then
  "$PKG/runtime/bin/node" -v

  # 附带 CLI 工具（若可在本机执行，报告版本；交叉架构构建跳过）
  if [ -d "$PKG/bin" ]; then
    for b in "$PKG"/bin/*; do
      [ -f "$b" ] || continue
      if "$b" --version >"$WORK/binver.log" 2>&1; then
        echo "   bin/$(basename "$b"): OK（$(head -n1 "$WORK/binver.log")）"
      else
        echo "   bin/$(basename "$b"): 无法在本机执行（交叉架构构建？），已随包分发"
      fi
    done
  fi

  # pi CLI：TUI 需要 PTY，用 script 给它一个伪终端，验证进程能存活而不是立刻崩掉
  # 通过软链调用（复现 install-to-path 场景）：启动器必须能解析出真实包目录
  rm -f "$WORK/pi.log" "$WORK/pi.pid"
  mkdir -p "$WORK/linktest"
  ln -sf "$PKG/pi" "$WORK/linktest/pi"
  ln -sf "$PKG/pi-web.sh" "$WORK/linktest/pi-web"
  if command -v script >/dev/null 2>&1; then
    PI_Q="$(printf '%q ' "$WORK/linktest/pi")"
    ( HOME="$SMOKE_HOME" script -qec "$PI_Q" /dev/null >"$WORK/pi.log" 2>&1 & echo $! >"$WORK/pi.pid" )
  else
    ( HOME="$SMOKE_HOME" "$WORK/linktest/pi" </dev/null >"$WORK/pi.log" 2>&1 & echo $! >"$WORK/pi.pid" )
  fi
  sleep 8
  if kill -0 "$(cat "$WORK/pi.pid")" 2>/dev/null; then
    echo "   pi CLI（经软链）: OK（保持存活）"
    kill "$(cat "$WORK/pi.pid")" 2>/dev/null || true
  else
    echo "   pi CLI: 启动失败，日志如下："
    sed 's/^/     /' "$WORK/pi.log" | tail -n 20
    exit 1
  fi

  # pi-web：必须能应答 HTTP（同样经软链调用）
  rm -f "$WORK/piweb.log" "$WORK/piweb.pid"
  ( HOME="$SMOKE_HOME" "$WORK/linktest/pi-web" --no-open -p 31099 >"$WORK/piweb.log" 2>&1 & echo $! >"$WORK/piweb.pid" )
  WEB_OK=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null http://127.0.0.1:31099 2>/dev/null; then WEB_OK=1; break; fi
    sleep 1
  done
  kill "$(cat "$WORK/piweb.pid")" 2>/dev/null || true
  pkill -f "next start.*31099" 2>/dev/null || true
  if [ "$WEB_OK" = "1" ]; then
    echo "   pi-web: OK（http://127.0.0.1:31099 正常应答）"
  else
    echo "   pi-web: 启动失败，日志如下："
    sed 's/^/     /' "$WORK/piweb.log" | tail -n 30
    exit 1
  fi

  # 沙盒平台（若打包）：mock 执行器 + 内存型 sqlite 起服，/health 必须应答
  if [ "${WITH_SANDBOX:-0}" = "1" ]; then
    rm -f "$WORK/platform.log" "$WORK/platform.pid"
    SMOKE_SBX_HOME="$WORK/smoke-platform-data"
    mkdir -p "$SMOKE_SBX_HOME"
    (
      cd "$PKG/sandbox/platform"
      env -i HOME="$SMOKE_SBX_HOME" PATH="$PATH" \
        NODE_ENV=production HOST=127.0.0.1 PORT=31090 \
        DB_DIALECT=sqlite SQLITE_PATH="$SMOKE_SBX_HOME/sbx.db" \
        JWT_SECRET=smoke-test-secret ADMIN_USERNAME=admin ADMIN_PASSWORD=changeme123 \
        EXECUTOR_KIND=mock REGISTER_MODE=off \
        "$PKG/runtime/bin/node" --experimental-transform-types --no-warnings=ExperimentalWarning src/index.ts \
        >"$WORK/platform.log" 2>&1 &
      echo $! > "$WORK/platform.pid"
    )
    SBX_OK=0
    for _ in $(seq 1 30); do
      if curl -fsS -o /dev/null http://127.0.0.1:31090/health 2>/dev/null; then SBX_OK=1; break; fi
      sleep 1
    done
    kill "$(cat "$WORK/platform.pid")" 2>/dev/null || true
    if [ "$SBX_OK" = "1" ]; then
      echo "   sandbox-platform: OK（mock 执行器 /health 应答正常）"
    else
      echo "   sandbox-platform: 启动失败，日志如下："
      sed 's/^/     /' "$WORK/platform.log" | tail -n 30
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 10. 打包
# ---------------------------------------------------------------------------
OUT="$OUT_DIR/amedac.ai-pi-linux-$ARCH-$VERSION.tar.gz"
log "打包 $OUT"
(cd "$WORK" && tar -czf "$OUT" "amedac.ai-pi-linux-$ARCH")
(cd "$OUT_DIR" && sha256sum "amedac.ai-pi-linux-$ARCH-$VERSION.tar.gz" > SHA256SUMS)
log "完成，产物："
ls -lh "$OUT" "$OUT_DIR/SHA256SUMS"
echo
echo "  将 amedac.ai-pi-linux-$ARCH/ 拷到目标 Linux 机器后："
if [ "$WITH_SANDBOX" = "1" ]; then
  echo "  【沙盒教学平台（一键部署）】"
  echo "    ./scripts/start-all.sh   启动沙盒平台 + WebUI（首次运行自动生成配置，"
  echo "                             数据落 data/；需目标机装有 Apptainer）"
  echo "    ./scripts/status-all.sh  服务状态与日志位置"
  echo "    ./scripts/stop-all.sh    停止全部服务"
  echo "  【组件单独用】"
fi
echo "    ./pi          启动 CLI Agent（用法同官方 pi 命令）"
echo "    ./pi-web.sh   启动 WebUI（浏览器访问 http://127.0.0.1:30141）"
echo "    ./scripts/start.sh    菜单入口（含安装到 PATH / 检查更新）"
echo "    ./scripts/install-to-path.sh  把 pi / pi-web 装到 PATH"
echo "    ./scripts/update.sh           检查并更新本包"
echo "    其余辅助脚本与文档均在 scripts/ 下（README.txt / VERSION.txt 等）"
if [ -d "$PKG/config/pi" ]; then
  echo "    ./update.sh  检查并更新（首次运行时配置模板已自动合并到 ~/.pi/agent）"
fi
