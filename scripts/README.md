# 构建 Linux 离线分发包

`scripts/package-linux.sh` 一键构建 pi-web + pi CLI Agent 的 Linux 离线包。
产物是一个自包含目录 + tar.gz，目标机器**不需要 Node.js、不需要联网**。

- 构建者文档：本文件
- 产物里的用户说明：`packaging/README.txt`（会随包分发）
- CI 自动化：`.github/workflows/package-linux.yml`

## 前置要求（构建机，非目标机）

- Linux（或 WSL）
- bash、tar、curl 或 wget
- **Node.js >= 22**（只用于安装依赖和执行 `next build`，产物里不包含它）

## 基本构建

```bash
bash scripts/package-linux.sh
```

产物：

```
dist/pi-linux-x64-0.8.6.tar.gz     # 离线包（含 SHA256SUMS）
build/package-linux/pi-linux-x64/  # 未压缩目录，可直接拷贝分发
```

## 使用本地编译的 pi-coding-agent（重点）

你的自编译包可以是：一个 `.tgz`、一个已解压的目录（含 `package.json`）、
或一个 `https://` URL。通过环境变量 `PI_CODING_AGENT_LOCAL` 传入：

```bash
# tgz 包
PI_CODING_AGENT_LOCAL=/data/pi-coding-agent-0.83.1.tgz bash scripts/package-linux.sh

# 已解压的目录
PI_CODING_AGENT_LOCAL=/data/pi-coding-agent-src bash scripts/package-linux.sh

# URL（CI 场景，指向内网/私有源）
PI_CODING_AGENT_LOCAL=https://intranet/pi-coding-agent-custom.tgz bash scripts/package-linux.sh
```

工作原理：构建脚本先把依赖改成 `file:` 说明符再 `npm install`，因此
`next build`、`npm prune` 都不会把本地版本回退成 registry 版本；本地 SDK
会进入最终产物并在运行时生效。脚本会打印实际装入的版本号便于核对。

## 其他参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ARCH` | `x64` | 目标架构，可设 `arm64` |
| `NODE_VERSION` | `22.19.0` | 内置 Node 运行时版本（>= 22.19.0） |
| `OUT_DIR` | `<仓库>/dist` | 产物目录 |
| `SMOKE_TEST` | `1` | 设为 `0` 跳过冒烟测试 |
| `SKIP_RUNTIME_DOWNLOAD` | - | 设为 `1` 复用包内已有的 `runtime/`（构建机离线时） |

冒烟测试会实际启动产物里的 `pi`（在伪终端里）和 `pi-web`（curl 检查
HTTP 应答），确认原生模块与运行时都正常后才打包。

## 在 Windows 上用 WSL 构建

```bash
# 在 WSL (Ubuntu) 里
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
cd /mnt/d/MyCourses/26Q3/LabTrainingProject/pi-web   # 挂载的仓库
bash scripts/package-linux.sh
```

注意：产物在 WSL 的文件系统里生成更稳（避免跨文件系统 IO 慢问题），
可设 `OUT_DIR=/home/你/pi-dist` 输出到 WSL 家目录再拷走。

## CI 说明

推送 `v*` tag 或手动触发 `.github/workflows/package-linux.yml` 后，
`ubuntu-latest` 会执行同一套构建并上传到 GitHub Release asset。
如需让 CI 使用你的自编译 pi-coding-agent，把可下载地址配置成仓库变量
`PI_CODING_AGENT_LOCAL`（Settings → Secrets and variables → Actions →
Variables）。

## 注意事项

- **按平台打包**：原生模块（next-swc、sharp、photon 等）是平台绑定的，
  x64 / arm64、Linux / macOS / Windows 各打各的包。本脚本只产出 Linux。
- **离线 ≠ 全功能**：模型 API 请求、技能安装、OAuth 等运行时联网功能在
  离线环境不可用（见 `packaging/README.txt`）。
- 仓库的 `.next/`、`node_modules/`、`build/`、`dist/` 均不会被打包；
  构建在一次性副本里进行，不改动你的开发环境。
