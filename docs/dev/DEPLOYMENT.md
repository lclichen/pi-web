# 部署与运维

> 状态：现行（2026-11-23）。构建/打包变量见 [packaging.md](./packaging.md)；
> 架构见 [PLATFORM.md](./PLATFORM.md)；平台服务见 [sandbox-platform.md](./sandbox-platform.md)。

## 1. 组件

| 组件 | 角色 | 包内位置 |
|---|---|---|
| pi-web | 多用户 WebUI / BFF / Agent runtime | `app/` |
| sandbox-platform | 平台账号、容器、workspace、配额、PTY、工具 API | `sandbox/platform/`（可选） |
| Agent Client | 用户机器上的 relay（下载分发，不随服务启动） | `agent/dist/` |
| Node runtime | 内置 Node.js，无需系统 Node | `runtime/` |

沙盒工具桥接已合并进 amedac-core / pi-config，不再需要独立
`pi-sandbox-extension`。没有沙盒组件时仍可运行 Host/本机/SSH 模式。

## 2. 产物形态

### tar.gz 目录版

```bash
tar -xzf amedac.ai-pi-linux-x64-<version>.tar.gz
cd amedac.ai-pi-linux-x64
./scripts/start-all.sh
```

### AppImage

```bash
./amedac.ai-x64.AppImage --web
./amedac.ai-x64.AppImage status
./amedac.ai-x64.AppImage stop
```

- 代码/运行时在只读挂载内执行，不整包释放；
- 数据在 `${XDG_DATA_HOME:-~/.local/share}/amedac/`（`AMEDAC_HOME` 可改）；
- 无 FUSE 时加 `--appimage-extract-and-run`。

两种形态共用：

```
amedac/
  config/   platform.env / piweb.env / admin-password.txt
  data/     平台 sqlite/overlay/workspace、piweb state/homes
  run/      pid/ports
  logs/     web.log / platform.log
```

升级只替换程序本体，`config/`、`data/`、`run/`、`logs/` 保留。

## 3. 首次启动

1. 生成 `config/platform.env`：sqlite、JWT secret、种子管理员；
2. 启动 sandbox-platform，等待 `/health`；
3. 生成 `config/piweb.env`：`PI_WEB_AUTH=on`、平台地址、数据目录；
4. 启动 pi-web `:30141`；
5. 浏览器访问 `http://<host>:30141`，用 `admin` + 初始密码登录。

初始密码：`amedac-admin`（可用 `ADMIN_PASSWORD` 覆盖），写在
`config/admin-password.txt`（0600），首次成功登录后删除。首次登录后建议改密。

没有 Apptainer 时：平台/WebUI/本机模式仍可用，但容器创建失败；`start-all.sh` 会检测提示。

## 4. 配置面

### platform.env

| 变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 平台监听（默认 3000/127.0.0.1） |
| `DB_DIALECT` / `SQLITE_PATH` / `DATABASE_URL` | sqlite 或 postgresql |
| `JWT_SECRET` | 登录令牌密钥（首启随机） |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | 种子管理员（空库首启） |
| `EXECUTOR_KIND` | `apptainer-cli` / `ssh` / `mock` / `auto`；生产 mock 拒绝，auto 失败关闭 |
| `REGISTER_MODE` | `off` / `open` / `approval` |
| `RATE_LIMIT_*` | 登录/注册/PTY/LLM reveal 限流 |
| `TRUST_PROXY` | 反代后按真实客户端 IP 限流 |

### piweb.env

| 变量 | 说明 |
|---|---|
| `PI_WEB_AUTH` | `on` 启用平台账号登录；`off` 单用户兼容 |
| `PI_WEB_PLATFORM_URL` | 平台 API 地址（服务端） |
| `PI_WEB_PLATFORM_PUBLIC_URL` | 浏览器跳转平台的对外地址（OIDC 等） |
| `PI_WEB_DATA_DIR` | WebUI 状态/项目/会话 home |
| `PI_WEB_SESSION_IDLE_DAYS` / `PI_WEB_SESSION_ABSOLUTE_DAYS` | 登录态窗口 |
| `PI_WEB_DISABLE_NPM_PACKAGES` | 离线优先；`0` 允许 npm 安装/更新 |
| `PI_WEB_NPM_REGISTRY` / `PI_WEB_PIP_INDEX_URL` | 包安装/终端镜像源 |
| `PI_RELAY_PORT` / `PI_RELAY_HOST` / `PI_RELAY_ADVERTISE_URL` | Agent relay |
| `PI_WEB_PUBLIC_URL` | 分享链接/配对命令的对外地址 |

`PI_WEB_SANDBOX_EXTENSION_PATH` 已废弃；旧配置残留无害。

## 5. 反向代理与 TLS

- 建议 nginx/caddy 终止 TLS，只暴露 WebUI；平台保持 127.0.0.1。
- relay 默认 30142，需要 WebSocket Upgrade。若只暴露 443/路径前缀，设置
  `PI_RELAY_ADVERTISE_URL=https://host/relay`。
- 设置 `PI_WEB_ALLOWED_HOSTS` 添加反代 hostname。
- `TRUST_PROXY` 配成反代跳数，限流才按真实 IP。

## 6. 进程守护

```ini
[Unit]
Description=Amedac Agent Platform
After=network.target

[Service]
Type=forking
WorkingDirectory=/opt/amedac
ExecStart=/opt/amedac/scripts/start-all.sh
ExecStop=/opt/amedac/scripts/stop-all.sh
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`start-all.sh` 幂等，可重复调用；建议由 systemd 统一管理。

## 7. 升级

### AppImage

替换文件并重新运行；`AMEDAC_HOME` 下配置/数据不受影响，数据库迁移幂等。

### tar.gz

```bash
cd amedac.ai-pi-linux-x64
./scripts/upgrade-bundle.sh /path/to/amedac.ai-pi-linux-x64-<new>.tar.gz
```

自动：停服 → 备份 config/data → 解压排除 config/data/run/logs → 迁移旧布局 → 重启。
手动等价命令必须排除 `config`、`data`、`run`、`logs`。

升级后：
- 平台 schema 幂等迁移；
- Agent Client 需用户重新下载/升级（下载路由指向新 dist）；
- 旧 `~/.pi/agent` 软链会在下次启动清理/重指。

## 8. 备份

- 平台 DB（sqlite 文件或 postgres dump）；
- `data/piweb`（项目/会话元数据、home、附件、bundle）；
- Apptainer 数据目录（容器实例 + overlay）；
- `config/`（env、admin password 文件、证书）。

建议平台自带 `npm run backup` 做可移植 JSON 归档；容器 overlay 另做一致性快照
（先 stop 再拷）。

## 9. 观测与故障排查

日志：

- 包启动：`logs/web.log`、`logs/platform.log`
- pi-web 应用 warn/error/event：`<data>/logs/server-YYYYMMDD.log`
- Agent relay：`web.log` 中 `[relay]`

| 症状 | 检查 |
|---|---|
| 平台 `/health` 不通 | `platform.log`、端口、DB 权限、executor 启动 |
| 登录 500 | `PI_WEB_PLATFORM_URL` 是否可达、平台账号 |
| WebUI 能登但建不了容器 | Apptainer/SSH executor、镜像白名单、配额 |
| 终端黑屏 | PTY/node-pty 绑定、平台版本、容器运行状态 |
| 本机模式不可用 | Agent 版本/在线、配对命令主机名、relay 30142 |
| 本机 MCP 不出现 | Agent ≥0.8、feature、plane/lazy/directTools |
| 文件面板 403 | 会话所属空间、项目归属、路径围栏 |
| 升级后配置丢 | 是否误覆盖 `config/`/`data/` |

## 10. 生产加固

1. 反向代理 + TLS；平台不直接暴露。
2. 强 `JWT_SECRET`、强管理员密码、关闭开放注册或审批。
3. 配置 `TRUST_PROXY` 与限流；限制每用户并发会话/批量任务。
4. 定期备份 DB/workspace/overlay；验证恢复。
5. 只给可信项目 `plane:"host"`/Host 模式；普通用户使用 sandbox/local-machine/SSH。
6. 监控 `/metrics`、磁盘、内存、relay 在线数、批量队列。
7. 离线环境保持 `PI_WEB_DISABLE_NPM_PACKAGES=1`；镜像源按内网配置。

## 11. 当前已知限制

- 单 pi-web Node 进程托管 Agent 会话；大量并发需拆执行面。
- 远程终端镜像环境是创建时快照；改镜像/离线开关后需重开终端。
- Windows Agent PTY 为桩，终端不可用。
- AppImage 依赖 FUSE；无 FUSE 用 extract-and-run。
- 平台账号外部删除/禁用不会实时推送；需管理端操作或 401 复查。
- 工作区投影/配置同步的剩余边界见 ADR 0004 与 state-storage-inventory。
