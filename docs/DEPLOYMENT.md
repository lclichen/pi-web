# 部署指南：沙盒教学平台 + WebUI 一键打包与部署

本文描述完整的 **沙盒教学平台（sandbox-platform）+ WebUI（pi-web）+ 沙盒桥接扩展（pi-sandbox-extension）** 打包、分发、部署流程。目标机为一个自包含目录，不需要联网、不需要系统级 Node.js。

```
┌────────────────────────── 目标 Linux 机器 ──────────────────────────┐
│                                                                      │
│  浏览器 ──► WebUI (pi-web)            :30141  ← app/ + runtime/     │
│                 │ PI_WEB_PLATFORM_URL                                │
│                 ▼                                                    │
│            sandbox-platform           :3000  ← sandbox/platform/    │
│                 │ apptainer exec / openPty                           │
│                 ▼                                                    │
│            Apptainer 容器（每项目一个实例，/workspace）              │
└──────────────────────────────────────────────────────────────────────┘
```

三个组件的分工：

| 组件 | 角色 | 包内位置 |
| --- | --- | --- |
| pi-web | 多用户 WebUI：会话/项目管理、文件浏览、终端、Agent 对话 | `app/` |
| sandbox-platform | 容器管理 API：容器生命周期/快照/云盘；sqlite 存储，启动自动迁移 | `sandbox/platform/` |
| pi-sandbox-extension | pi 的工具桥接扩展：bash/read/write 在容器内执行 | `sandbox/extension/` |

---

## 一、构建离线包（构建机）

前置要求：Linux（或 WSL）、bash、tar、curl/wget、Node.js ≥ 22（只用于构建）。三份源码需在同一父目录下（或用环境变量显式指定路径）：

```
somewhere/
├── pi-web/                  # 本仓库
├── sandbox-platform/        # 容器管理平台
└── pi-sandbox-extension/    # 桥接扩展
```

```bash
cd pi-web
bash scripts/package-linux.sh
```

产物：

```
dist/amedac.ai-pi-linux-x64-<版本>.tar.gz   # 分发包（附 SHA256SUMS）
build/package-linux/amedac.ai-pi-linux-x64/ # 未压缩目录
```

脚本行为要点：

- 自动探测兄弟目录中的 `sandbox-platform` / `pi-sandbox-extension` 并打入包内（探测不到则跳过沙盒组件，只出纯 pi/pi-web 包）。可用 `WITH_SANDBOX=1|0` 强制开关，路径不同用 `SANDBOX_PLATFORM_DIR=` / `SANDBOX_EXTENSION_DIR=` 指定。
- 打入内置 Node.js 运行时（默认 v22.23.0，可换 `NODE_VERSION` / `NODE_RUNTIME_LOCAL`）。
- 冒烟测试（可用 `SMOKE_TEST=0` 跳过）：CLI 存活、WebUI HTTP 应答、**沙盒平台以 mock 执行器启动且 `/health` 应答**。

常用变量（全部可选）见 `scripts/package-linux.sh` 头部注释；最常用的几个：

```bash
# 指定本地 node 运行时（完全离线的构建机）
NODE_RUNTIME_LOCAL=/data/node-v22.23.0-linux-x64.tar.gz bash scripts/package-linux.sh

# 本地编译的 pi-coding-agent SDK 替换 registry 版本
PI_CODING_AGENT_LOCAL=/data/pi-coding-agent-0.83.x.tgz bash scripts/package-linux.sh

# 附带 fd/rg 等 CLI 工具进包（目标机 PATH 自动生效）
PI_BINARIES="/data/fd /data/rg" bash scripts/package-linux.sh

# 离线构建机：手动补原生绑定（bcrypt 预编译）与管理控制台静态页
BCRYPT_BINDING_LOCAL=/data/bcrypt_lib.node \
PLATFORM_WEB_DIST=/data/web-dist \
bash scripts/package-linux.sh
```

两个离线机常见坑：

- **bcrypt .node 绑定缺失**（运行时报 `Cannot find module .../napi-v3/bcrypt_lib.node`）：
  离线 npm 拿不到 node-pre-gyp 预编译（`ignore-scripts=true` 时甚至不会尝试）。手动把对应
  平台的 `bcrypt_lib.node` 拷到构建机后用 `BCRYPT_BINDING_LOCAL` 指给脚本；其他原生模块同理走
  `NATIVE_BINDING_FIX="包内相对路径=来源文件 …"`。
- **管理控制台**：管理员在 WebUI 顶栏点「沙盒平台管理台」新标签页打开平台 SPA（镜像/用户/
  配额/LLM 控制台）。打包时默认嵌入源码仓的 `web/dist`；构建机上没有就绪产物时用
  `PLATFORM_WEB_DIST` 指定，否则该页 404（其余功能不受影响）。

## 二、目标机一键部署

### 方式 A：AppImage（桌面双击 / 单文件分发）

```bash
bash scripts/package-appimage.sh       # 构建机；复用 package-linux.sh 产物再打镜像
# → dist/amedac.ai-x64.AppImage (约 215MB)
```

代码与运行时**留在只读挂载内就地执行**（标准 AppImage 方式，不再整包释放到家目录）；
可写内容收敛到 `${XDG_DATA_HOME:-~/.local/share}/amedac/`（可用 `AMEDAC_HOME` 指到任意
外部数据目录，如 NAS 数据盘）：

```
amedac/
├── config/   platform.env、piweb.env（首启生成，可手改；含 admin-password.txt）
├── data/     平台 sqlite、容器 overlay、WebUI 数据
├── run/      pid 与 ports.env（自动选中的端口）
└── logs/     服务日志
```

命令面（无 FUSE 的机器整体加 `--appimage-extract-and-run` 后缀，行为一致）：

```bash
./amedac.ai-x64.AppImage              # 启动 pi CLI（参数透传给 pi；不拉起后台服务）
./amedac.ai-x64.AppImage --web        # 启动平台+WebUI（自动端口）并打开浏览器
./amedac.ai-x64.AppImage status       # 服务状态
./amedac.ai-x64.AppImage stop         # 停止全部
```

端口全自动：默认从 3000/30141 起，被占用就向上探测空闲端口，结果记忆在
`run/ports.env`（下次优先复用）。要固定端口，在 `config/platform.env` 加 `PORT=xxxx`
或 `config/piweb.env` 加 `PI_WEB_PLATFORM_URL=http://…`，显式配置优先于自动探测；
WebUI 的平台地址默认跟随探测到的平台端口。桌面双击图标 = `--web`（起服务 + 开浏览器）。
旧版（v1，曾整包展开约 1GB 到家目录）首次运行 v2 时自动迁移配置并清理旧目录，数据不丢。

### 方式 B：tar.gz 目录部署

要求：Linux x64/arm64、bash；如需真实沙箱容器还要安装 [Apptainer](https://apptainer.org/docs/admin/latest/installation.html)（未装也能跑 WebUI 与本机模式，只是无法建容器——`start-all.sh` 会检测并提示）。

```bash
tar -xzf amedac.ai-pi-linux-x64-<版本>.tar.gz
cd amedac.ai-pi-linux-x64
./scripts/start-all.sh
```

首次运行会自动完成：

1. 生成 `sandbox/platform.env`（sqlite 数据库落在 `data/platform/`、64 位随机 JWT 密钥、随机强密码的种子管理员——初始密码写入 `sandbox/admin-password.txt`，仅属主可读）；
2. 启动沙盒平台（端口 `3000`，`/health` 就绪才继续）；
3. 生成 `sandbox/piweb.env`（指向平台、开启登录、数据落 `data/piweb/`、扩展指到包内 `sandbox/extension/`）；
4. 启动 WebUI（端口 `30141`）。

浏览器访问 `http://<主机IP>:30141/`，用 **admin** 和 **`sandbox/admin-password.txt` 里的初始密码**登录（WebUI 与沙盒平台共用同一套账号），**登录后立即改密并可删除该密码文件**。

其他命令：

```bash
./scripts/status-all.sh   # 状态 / 日志位置 / apptainer 检测
tail -f logs/web.log      # 跟踪 WebUI 日志
tail -f logs/platform.log # 跟踪平台日志
./scripts/stop-all.sh     # 停止全部
./scripts/start-all.sh --no-web   # 只起沙盒平台（调试用）
```

端口自定义：`PLATFORM_PORT=3000 WEB_PORT=8080 ./scripts/start-all.sh`。

## 三、配置参考

`start-all.sh` 生成的两个 env 即完整配置面，改完重启对应服务即可：

**sandbox/platform.env**

| 变量 | 说明 |
| --- | --- |
| `PORT` / `HOST` | 监听地址（默认仅本机回环，WebUI 反向代理访问） |
| `DB_DIALECT` / `SQLITE_PATH` | sqlite 零依赖；大规模可换 `postgresql` + `DATABASE_URL` |
| `JWT_SECRET` | 登录令牌签名密钥（首次自动随机生成） |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | 种子管理员（仅空库首次启动时创建；生产模式拒绝默认弱密码） |
| `EXECUTOR_KIND` | `apptainer-cli`（同机 Apptainer）/ `ssh`（远程节点）/ `mock` |
| `REGISTER_MODE` | 注册开关：`off` / `open` / `approval` |
| `RATE_LIMIT_*` | 登录/注册等接口限流阈值（生产默认开启） |

**piweb.env**

| 变量 | 说明 |
| --- | --- |
| `PI_WEB_AUTH` | `on` = 多用户账号体系（WebUI 自己的用户库） |
| `PI_WEB_PLATFORM_URL` | 沙盒平台地址；学生用户的平台凭证在 WebUI 内绑定 |
| `PI_WEB_DATA_DIR` | 会话元数据 / 项目数据目录 |
| `PI_WEB_SANDBOX_EXTENSION_PATH` | 沙盒桥接扩展路径（会话以 `.pi/extensions/` 发现加载） |
| `PI_WEB_LAB_TRAINING` | 教学面板功能开关 |

## 四、升级

**AppImage**：下发新版本文件，直接重新运行即可——AppRun 检测到版本变化会自动重展开新包，
并原样还原 `sandbox/platform.env`、`sandbox/piweb.env` 与整个 `data/`（数据库迁移幂等）。

**tar.gz 目录部署**：

```bash
cd amedac.ai-pi-linux-x64
./scripts/stop-all.sh
# 解压新包覆盖（保留 data/、sandbox/*.env、logs/）
tar -xzf ../amedac.ai-pi-linux-x64-<新版本>.tar.gz --strip-components=1 -C . \
    --exclude='data' --exclude='run' --exclude='logs'
./scripts/start-all.sh
```

- 平台数据库 schema 由启动时的幂等迁移自动升级；
- sqlite 数据库、平台/WebUI 配置都在 `data/` 与 `sandbox/*.env`，不在覆盖范围；
- 学生容器的 overlay（Apptainer 数据目录，见下）与包目录无关，升级不动它们。

## 五、生产加固建议

1. **反向代理**：把 WebUI 放 nginx/caddy 后面配 TLS，再让用户走域名；此时平台保持只监听 127.0.0.1。
2. **进程守护**：`start-all.sh` 是裸 nohup 方案；长期运行建议包一层 systemd 单元，`ExecStart` 直接调 `./scripts/start-all.sh`（脚本幂等，重复调用安全），`Restart=on-failure`。
3. **限流**：平台生产模式默认开 IP 限流；若置于反代之后设 `TRUST_PROXY=<跳数>` 使按真实客户端 IP 计数。
4. **备份**：定期备份 `data/`（含平台 sqlite）与学生容器所在 Apptainer 数据目录（实例 + overlay，路径由平台 env 中 executor 配置决定）。
5. **凭证**：学生平台密码、“沙箱绑定”的 API key 都存于 pi-web 用户库里（`data/piweb/`），迁移机器时随 `data/` 一起搬。

## 六、故障排查速查

| 症状 | 检查点 |
| --- | --- |
| 平台 `/health` 不通 | `logs/platform.log`；端口占用（`status-all.sh`）；DB 路径权限 |
| WebUI 能登但建不了容器 | 目标机没装 Apptainer 或平台 `EXECUTOR_KIND` 不符；`logs/platform.log` |
| 终端黑屏只有 ready | 平台 <1.0 无 PTY 版本症状，升级到含 node-pty 的版本（≥ `18bd49f`） |
| 远程文件/终端报「该会话是 Host 模式」 | pi-web < `68d7e55` 的已知 bug，升级即可 |
| 新建终端偶发 429 | 平台限制每容器并发 3 个 PTY；旧泄漏连接约 1 分钟内自动回收 |
