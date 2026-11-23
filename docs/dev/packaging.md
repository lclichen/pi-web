# 打包与发布

> 状态：现行（2026-11-23）。面向构建机/发布负责人。最终用户的包内说明仍是
> `packaging/README.txt`；部署/升级见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 1. 产物

| 脚本 | 产物 | 用途 |
|---|---|---|
| `scripts/package-linux.sh` | `dist/amedac.ai-pi-linux-<arch>-<version>.tar.gz` + SHA256 | 目录版离线包 |
| `scripts/package-linux.sh`（`GLIBC_COMPAT=217`） | `...-glibc-217.tar.gz` | CentOS 7/glibc 2.17 |
| `scripts/package-appimage.sh` | `dist/amedac.ai-x64.AppImage` | 单文件桌面分发 |
| `agent/scripts/build.sh` | `agent/dist/agent-client-*` | 五平台 Agent Client |

包内布局：

```
app/        pi-web 应用（.next/public/node_modules/bin）
runtime/    内置 Node.js
config/     可选的 pi 配置模板（扩展/技能/npm）
agent/      Agent Client dist + install.sh
sandbox/    可选 sandbox-platform（平台 API）
LICENSES/   组件/特殊第三方许可证全文
NOTICE / THIRD_PARTY_NOTICES.md
scripts/    start-all/stop-all/status-all/upgrade/update/install-pi-config
pi, pi-web.sh, README.txt
```

`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`LICENSES/` 由 `package-linux.sh`
复制到包根；`slim-package.sh` 不得删除它们。分发许可检查见
[licensing.md](./licensing.md)。

## 2. 构建机要求

- Linux 或 WSL、bash、tar、curl/wget；
- Node.js ≥ 22（仅构建机，产物自带 runtime）；
- 同父目录的源码：`pi-web`、`sandbox-platform`（可选；沙盒工具桥接已并入
  amedac-core，不再需要独立的 `pi-sandbox-extension`）；
- 目标机如要容器能力：Apptainer（≥1.x）。

## 3. 常规构建

```bash
cd pi-web
bash scripts/package-linux.sh
```

关键行为：

1. `npm ci` / 构建 `.next`；
2. 探测兄弟目录的 `sandbox-platform`（`WITH_SANDBOX=1/0` 可强制）；
3. 下载/复用 Node runtime；
4. 打入 `agent/dist`（若存在）；
5. 打入 pi 配置模板 `config/pi/`（`PI_CONFIG_DIR`，可混淆自有扩展）；
6. `slim-package.sh` 默认瘦身（`SLIM_PACKAGE=0` 跳过）；
7. 冒烟测试（`SMOKE_TEST=0` 跳过）：CLI 存活、WebUI HTTP、平台 `/health`（mock）。

`slim-package.sh` 在检测到 `next.config.ts` 的 `images.unoptimized=true` 时，会移除
Next 的可选 `sharp` / `@img/sharp-*` / `@img/colour` 依赖（包括 LGPL libvips），
避免无用的图片优化器和 LGPL 合规负担。若以后启用 Next 图片优化、使用
`SLIM_PACKAGE=0` 跳过瘦身，或自行安装 sharp，必须保留它们并恢复 `LICENSES/`
中的 LGPL 材料。

## 4. 常用变量

| 变量 | 说明 |
|---|---|
| `ARCH` | `x64` / `arm64` |
| `NODE_VERSION` | 内置 Node 版本（默认 22.23.0） |
| `NODE_RUNTIME_LOCAL` | 离线 Node 包/目录/URL |
| `PI_CODING_AGENT_LOCAL` | 本地编译的 pi-coding-agent tgz/目录/URL |
| `PI_CONFIG_DIR` | 随包 pi 配置模板（默认 `pi-config/`） |
| `PI_CONFIG_VERSION` | 配置模板版本（目标机增量合并） |
| `PI_EXTENSIONS` | 预装本地扩展目录列表（含依赖） |
| `PI_BINARIES` | fd/rg 等二进制，包内 `bin/` 自动进 PATH |
| `WITH_SANDBOX` | 是否打 sandbox-platform |
| `SANDBOX_PLATFORM_DIR` | 平台源码路径 |
| `GLIBC_COMPAT=217` | CentOS 7 兼容包（需 Node/node-pty 2.17 构建） |
| `NODE_PTY_LOCAL` | glibc 2.17 node-pty 绑定/包 |
| `PI_UPDATE_BASE_URL` | 更新源（versions.json） |
| `SMOKE_TEST=0` / `SLIM_PACKAGE=0` | 跳过冒烟/瘦身 |
| `OBFUSCATE_PI_CONFIG=1` | 自有扩展 esbuild 混淆（非加密） |

## 5. glibc 2.17 / CentOS 7

- 官方 Node 包要求 glibc ≥2.28；必须用 `NODE_RUNTIME_LOCAL` 指向 glibc 2.17 构建。
- `node-pty` 原生绑定必须同 ABI/架构；`NODE_PTY_LOCAL` 指向 `.node` 或完整包。
- Next/SWC 原生绑定可能要求 GLIBC 2.29；Next 会回退到 wasm。包内**必须**保留：
  `app/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm.js`（或顶层包）。
- 运行时 SWC 回退警告由 `bin/next-silence-swc-warnings.cjs` 过滤；fatal 错误仍显示；
  `PI_WEB_SILENCE_SWC_WARNINGS=0` 可关闭过滤。

## 6. 瘦身（slim-package.sh）

默认删除运行时不加载的构建残留：

- 全包 `*.map`（runtime 除外）
- app/config/sandbox 下 `.d.ts`、`@types`
- `monaco-editor` npm 包（前端用 `public/monaco` 自托管）
- recheck jar + 非 Linux 原生包（Linux 原生保留）
- `.next/{types,trace,cache,dev}`

不自动处理（发布人手工确认）：

- `runtime/bin/node` strip（失败可能损坏二进制）
- 扩展目录里的测试/媒体/banner（可能与运行时资源重叠）
- `--aggressive` 才删除 lucide-react、caniuse-lite、pi-coding-agent docs、Linux
  recheck 原生包（必须冒烟）。

完整性自检会拒绝缺失：Node 可执行、`.next/server`、public monaco、Next wasm、
Linux SWC、sharp、pi-coding-agent + vendor。

## 7. AppImage

`scripts/package-appimage.sh` 复用 tar 包产物：

- 代码/运行时在只读挂载内执行，**不整包释放**；
- 可写数据在 `${XDG_DATA_HOME:-~/.local/share}/amedac/`（`AMEDAC_HOME` 可改）；
- `--web` 前台监护启动平台+WebUI，`status`/`stop` 管理；
- 端口自动探测，写入 `run/ports.env`；`--appimage-extract-and-run` 适配无 FUSE。

## 8. Agent Client dist

```bash
cd agent && bash scripts/build.sh
```

- 五平台：linux/darwin amd64/arm64 + windows amd64；
- CGO 关闭，Linux 静态链接；
- 版本在 `agent/main.go`；feature 列表随 hello 上报；
- 打包脚本把 `agent/dist` 拷入包内；下载路由从同一目录下发；
- 直接执行 Linux 二进制前需 `chmod +x`（安装脚本负责）。

## 9. 发布检查清单

1. `npm test`、`tsc --noEmit`、Go `go test ./...` 全绿；
2. 版本号（`version.json`/package）与 Agent 版本一致；
3. `agent/dist` 已 rebuild 并包含新 feature（`strings | grep` 或 hello）；
4. `slim-package.sh` 自检通过；
5. 目标机/VM：BUILD-OK、`:30141` 可达、`/api/webauth/config` 200、登录；
5a. 包根含 `LICENSE`/`NOTICE`/`THIRD_PARTY_NOTICES.md`/`LICENSES/`，LGPL/MPL/CC-BY 文本齐全；
5b. `images.unoptimized=true` 的包不含 `sharp`/`@img/sharp-*`；若启用图片优化，则必须恢复 sharp 并保留 LGPL 材料；
6. 下载路由返回正确二进制大小；本机模式能配对/连接；
7. 沙盒模式：平台 `/health`、容器创建、工具/PTY；
8. 升级：`upgrade-bundle.sh` 保留 config/data，回滚可用。

## 10. 已知坑

- 组件源码不在兄弟目录：显式 `SANDBOX_PLATFORM_DIR`；`WITH_SANDBOX=1` 找不到会失败。
- 离线构建缺 bcrypt native：`NATIVE_BINDING_FIX` / `BCRYPT_BINDING_LOCAL`。
- 平台管理 SPA 已移除，统一进 pi-web 管理面板；旧 `PLATFORM_WEB_DIST` 无效。
- 包目录只读时，`install-pi-config.sh` 默认软链；删包前用 `AMEDAC_PKG_MODE=copy`
  转真实拷贝，避免 `~/.pi/agent` 悬空。
- Next 构建必须用 Turbopack；不要在 dev 服务运行时 `next build` 同一 `.next`。
