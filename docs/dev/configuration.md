# 配置层次与存储

> 状态：现行（2026-11-23）。描述 Global / User / Project 三层配置、精确路径、优先级、
> 投影与迁移。运行状态文件清单见 [state-storage-inventory.md](./state-storage-inventory.md)。

## 1. 三层模型

| 层 | 定位 | 主要位置 | 修改者 |
|---|---|---|---|
| **Global** | 部署默认、共享资源 | `<agentDir>`（默认 `~/.pi/agent`）、`<dataDir>/state/global/` | 管理员 |
| **User** | 个人偏好与个人资源 | `<dataDir>/state/users/u<id>/`、`<dataDir>/user-config/u<id>/` | 用户自己/管理员 |
| **Project** | 项目 `.pi` 与项目数据 | `<projectHome>/.pi`、`<dataDir>/state/projects/<projectId>/` | 项目属主/管理员 |

优先级：**Global < User < Project**。同名资源按层覆盖；项目 `.pi` 是 SDK 与
pi-mcp-adapter 直接读取的最终项目配置。

## 2. Global 层

- `~/.pi/agent/`（可用 `PI_CODING_AGENT_DIR` 改）：
  - `models.json`、`auth.json`、`settings.json`
  - `extensions/`、`skills/`、`agents/`
  - `npm/`（插件包与依赖）
- `<dataDir>/state/global/*.json`：项目索引、会话元数据、host 目录、server settings、
  quick templates、config bundle metadata、API key vault、apkg 状态等。
- 只有管理员可写全局配置；普通用户请求全局 scope 返回 403。

## 3. User 层

JSON 配置源（统一 `{schemaVersion,data}` 信封，0600）：

```
<dataDir>/state/users/u<id>/
  user-settings.json      UI/默认模型/思考/工具/语言等偏好
  sidebar-state.json      项目/Host/会话置顶、未读
  push.json               Web Push 订阅
  pi/settings.json        pi settings 用户 diff
  pi/mcp.json             用户级 MCP
  pi/models.json          用户级模型配置
  pi/auth.json            用户级凭据（0600）
```

文件型资源（不是 JSON store）：

```
<dataDir>/user-config/u<id>/
  skills/ agents/ plugins/
```

`<dataDir>/user-runtime/u<id>/mcp.json` 是 Global+User 合并后的派生文件，不是
事实源，可重建。

`userId=0` 是 auth-off 的隐式 host 身份，不建立 `state/users/u0`，继续使用全局
agentDir。

旧路径 `user-config/u<id>/{settings.json,mcp.json}`、`user-settings/u<id>.json`、
`user-models/u<id>/` 只读保留一个发布周期；首次读取/写入时迁移到新路径。

## 4. Project 层

项目 home 由项目形态决定：

| 项目模式 | projectHome |
|---|---|
| sandbox | `<dataDir>/sandbox-homes/u<owner>/<projectId>/` |
| local-machine | `<dataDir>/local-homes/u<owner>/<projectId>/` |
| ssh | `<dataDir>/local-homes/u<owner>/<projectId>/`（会话 cwd 仍在服务器） |
| host | 管理员选择的外部目录（`workspaceRoot`） |
| quick | `<dataDir>/quick-homes/u<owner>/<vN>/`（版本化 scratch） |

项目 `.pi/` 可包含：

- `settings.json`、`models.json`、`auth.json`（项目覆盖，凭据 0600）
- `mcp.json`、`subagents.json`、`agents/`、`skills/`、`extensions/`
- `AGENTS.md`（项目根）、`.pi/bundle.json`（Agent 包声明）
- `ssh.json`（SSH 项目凭据）、`sandbox-platform.json`（沙盒容器绑定）
- `path-policy.json` / `path-policy.decisions.json`（路径护栏策略/决策）
- `.pi/attachments/`（聊天附件的主存）

项目配置写入经过项目写锁；模型/凭据、AGENTS.md、sandbox 凭据等一次性验证后再落盘。

## 5. 资源类型与作用域

| 资源 | Global | User | Project | 说明 |
|---|---|---|---|---|
| 模型/凭据 | ✅ | ✅ | ✅ | 项目覆盖模型运行时 |
| MCP | ✅ | ✅ | ✅ | 项目同名优先；项目可写墓碑 |
| Skills | ✅ | ✅ | ✅ | 文件资源，非 JSON |
| Agents/子代理 | ✅ | ✅ | ✅ | 用户目录按真实路径归因 |
| Plugins/扩展 | ✅ | ✅ | ✅ | 用户插件复用全局 npm 根 |
| 路径策略/信任 | — | — | ✅ | 项目级 |
| Web 偏好/侧栏 | — | ✅ | — | 用户级 |
| Quick 模板 | ✅（管理员） | — | — | 快速会话模板 |

## 6. 配置投影与同步

远端模式下，SDK 读取的是服务器项目 home 的 `.pi`，不是用户机器/容器里的副本。

- **Projection（单向）**：项目 `.pi/{skills,agents,extensions,AGENTS.md,...}` 复制到
  工作区；`.git`、`node_modules/.cache` 等跳过；manifest 快取 + 逐文件回退；
  远端删除绝不依据截断 manifest。
- **Sync（显式）**：用户在项目菜单执行“工作区 → 项目”同步；先 dry-run 展示差异，
  再经过配置 schema、凭证剥离、工具模式、项目信任检查；写前备份，可回滚。
- **附件**：Host 为主存，远端镜像失败不会插入悬空引用。
- **模型**：`models.json` 不进入工作区同步，避免环境绑定。

## 7. 环境变量覆盖

常用路径/行为变量：

| 变量 | 作用 |
|---|---|
| `PI_WEB_DATA_DIR` | pi-web 状态/工作区根 |
| `PI_CODING_AGENT_DIR` | pi agent 全局目录 |
| `AMEDAC_HOME` / `AMEDAC_CONFIG_DIR` / `DATA_DIR` | 打包运行时的可变数据目录 |
| `PI_WEB_DISABLE_NPM_PACKAGES` | 离线优先：禁用 npm 自动安装/更新 |
| `PI_WEB_NPM_REGISTRY` / `PI_WEB_PIP_INDEX_URL` | 包安装与终端镜像源 |
| `PI_WEB_PLATFORM_URL` | 平台 API 地址 |
| `PI_WEB_AUTH` | `on` 启用平台多用户登录 |
| `PI_WEB_SESSION_IDLE_DAYS` / `PI_WEB_SESSION_ABSOLUTE_DAYS` | 登录态窗口 |

完整部署变量见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 8. 写入与并发

- JSON state：`lib/state/json-store.ts` 统一信封、临时文件+rename、`.bak`、0600/0700、
  `proper-lockfile` 跨进程写锁、mtime 缓存。
- 项目配置：`withProjectConfigWriteLock` 与会话启动的读锁互斥，避免删除/切换 TOCTOU。
- 私有文件：MCP、sandbox 凭据、batch task、session image metadata 等使用原子私有写。
- 损坏文件回退顺序：`.bak` → 旧路径 → defaults；不静默覆盖未知字段。

## 9. 迁移与清理

- 旧 user JSON、旧 projects/session-metas 路径：懒迁移到 `state/`，旧文件保留。
- 项目删除：清项目 `.pi` 依赖的 sidecar、pins、projection、sync plan、apkg 锁、
  batch、shares、images、会话 JSONL；外部 Host 目录保留。
- 用户删除：清用户 state/user-config/homes/attachments/会话空间，吊销登录/vault/relay
  token；平台账号删除是源操作，pi-web 只清本地派生状态。
- 卸载/升级：可变数据在 `AMEDAC_HOME`，包目录只读可替换。

## 10. 当前边界

- 部分 store（web-sessions、shares、batch-tasks、projection/status、sync-plans、
  embed-profiles、mcp-quick）尚未全部接入统一锁/GC。
- 平台侧直接删除用户/禁用账号不会实时推送；管理端操作会立即失效本地状态，
  周期性复查待补。
- 项目 `.pi` 的扩展/技能会随项目信任执行；导入不明来源配置包前应检查
  `.pi/extensions/`。
