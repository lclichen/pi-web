# pi-web 用户系统与多模式融合设计

> 状态：设计稿（待评审）
> 关联：`AgentSandbox/docs/PI-WEB-INTEGRATION-REQUIREMENTS.md`（沙箱平台侧需求，另行补充实现）
> 背景：pi-web 目前是单用户本地应用；sandbox-platform 提供多用户账号、容器隔离与配额。本文设计两者融合，以及 Go relay 与容器功能并行的三模式架构。

## 1. 目标与非目标

**目标**
1. 多用户：注册/登录（依托沙箱平台账号）、目录权限分配、会话隔离。
2. 三种执行模式并行：**沙箱模式**（平台容器）、**本机模式**（Web 专有，Go relay 到用户自己的电脑）、**Host 模式**（管理员专有，服务器本地全功能）。
3. CLI 与 Web 会话互见：CLI 无登录概念，其会话归入 Host 空间，管理员在 Web 中可查看。

**非目标（本期不做）**
- 模型网关 / 模型密钥自动分配：**默认关闭**，网关后期可能不上线（见 §6）。
- 平台侧新功能（自注册、PTY WebSocket 等）：见平台需求文档，由平台仓库实现。
- 多节点调度、Keycloak 等蓝图组件。

## 2. 角色与模式

角色沿用平台模型：`user` / `admin`（平台 `users.role`）。

| | 沙箱模式 | 本机模式（Web 专有） | Host 模式（管理员专有） |
|---|---|---|---|
| 可用者 | 所有登录用户 | 所有登录用户（需配对本机 relay） | 仅 `admin` |
| agent 进程位置 | pi-web Node 进程 | pi-web Node 进程 | pi-web Node 进程 |
| 工具执行位置 | 用户的平台容器 `/workspace` | **用户本机**（Go relay `fs.*`/`exec.*`/`pty.*`） | pi-web 服务器本地 |
| 工具通道 | `pi-sandbox-extension`（改写 read/write/edit/bash/ls/find/grep → 平台 REST） | relay 版工具改写（新增，见 §5.3） | 现状（SDK 内置本地工具） |
| cwd 语义 | `/workspace`（容器内，扩展已在 `before_agent_start` 改写提示词） | 用户本机目录（relay 共享根内） | 服务器目录 |
| 文件面板数据源 | 平台 `workspaces` + `/tools/read|write` | relay `fs.*` | 现有 `/api/files/*` |
| 终端数据源 | 平台 PTY WS（平台需求 R2） | relay `pty.*`（已实现） | 现有 `/api/terminal/*` |
| 会话空间 | 用户分片空间 | 用户分片空间 | Host 全局空间（含 CLI 会话） |

要点：**三种模式的差异只在"工具执行层"**——agent 会话（LLM 流、会话文件、子代理编排、浮窗/目录面板）始终在 pi-web 进程内，现有的子智能体可见性功能对三种模式通用。

## 3. 用户系统（依托平台账号）

平台部署是确定的，pi-web 不自建账号表。

- **登录**：pi-web 登录页 → 服务端调平台 `POST /api/v1/auth/login` → 将 access/refresh 存 pi-web 侧会话（httpOnly cookie 标识），平台令牌只留在服务端。
- **会话保持**：pi-web 服务端用 refresh token 自动续期（平台的旋转 + 家族撤销已实现）；失效则 Web 登出。
- **BFF 化**：所有需要平台资源的 pi-web API 路由（沙箱模式下的文件/终端/容器列表）由服务端携带该用户平台令牌转发；浏览器不接触平台 token。
- **角色**：`/api/v1/auth/me` 取回角色，决定 Host 模式与空间切换的可见性。
- **单用户回退**：未启用用户系统（`PI_WEB_AUTH=off`）时维持现状单用户形态，全部功能可用（部署初期兼容）。
- 注册入口属于平台侧（需求 R1），pi-web 登录页只放"注册"外链。

## 4. 会话隔离与 CLI 互见

### 4.1 会话空间（Session Spaces）

```
<PI 会话根目录>/                ← Host 空间（现状全局目录；CLI 与 Host 模式共用）
<PI 会话根目录>/users/<uid>/    ← 每个登录用户的分片空间（沙箱/本机模式会话）
```

- pi-web 创建会话时按当前用户传分片 `sessionDir` 给 SDK（`SessionManager.create(cwd, sessionDir)`，pi 已支持）。
- **CLI 不做任何改动**：CLI 会话继续写入全局目录，即 Host 空间。
- Web 管理员界面提供空间切换器（「我的会话 / Host 会话」），仅在 `admin` 角色显示 Host 项。
- `/api/sessions` 及全部会话读取路由按当前空间过滤；**隔离即路径围栏**：resolveSessionPath 结果必须落在当前空间目录内，越界一律 404（沿用平台"不泄露存在性"原则），无需维护会话-ID→owner 映射表。
- 内存会话注册表（`__piSessions`）增加 `ownerUserId` + `space`，`/api/agent/[id]` 全系路由（含 SSE events、bash-output 等）先做归属校验。

### 4.2 各资源的隔离方式

| 资源 | 隔离机制 |
|---|---|
| 会话文件 | 空间分片目录（上节） |
| 容器 | 平台 owner 隔离（已有，404 原则） |
| workspaces | 平台每用户目录 + 路径围栏（已有） |
| Go relay 连接 | pairing 后归属该用户（多 relay 并存，见 §5.3） |
| 服务器本地目录 | 仅 Host 模式可达；普通用户的请求永远不落到本地 fs API（服务端按模式路由拒绝） |
| 模型凭证 | 见 §6 |

## 5. 三模式实现要点

### 5.1 沙箱模式
- 会话创建时注入 `pi-sandbox-extension`（项目级动态加载）+ 环境变量 `SANDBOX_PLATFORM_URL` / `SANDBOX_TOKEN`（服务端持有）。
- 容器选择：沿用扩展的自动供给（首个运行中 → 提示 → 自动创建 + 首次同步）；pi-web 会话设置中暴露容器选择器（调平台 `/api/v1/containers?filter=running`）。
- 本地回退关闭：多用户下扩展的"无容器则本地执行"回退必须禁用（否则变成服务器本地执行）。
- 文件面板：`/api/files/*` 增加模式感知——沙箱会话改调平台 workspaces/tools；Monaco、差异视图、上传等 UI 不变。

### 5.2 Host 模式
- 即现状全功能（本地工具、`/api/files`、`/api/terminal`、workspace 终端），会话落在 Host 空间。
- 仅 `admin` 可用；Host 空间内可看到 CLI 会话并打开（对话、子智能体目录等只读能力天然复用）。

### 5.3 本机模式（Web 专有，relay 远程执行）
- agent 进程在 pi-web，但工具经 Go relay 到**该用户自己的电脑**执行。
- **relay 版工具改写**：新增一个 pi-web 内置扩展（参照 pi-sandbox-extension 的做法），把 read/write/edit/bash/ls/find/grep 改道到该用户 relay 连接的 `fs.*`/`exec.*`。
- **多 relay 并存**（pi-web 侧改动）：relay 注册表从单槽（`getRegistry().agent`）改为 `connectionId → { userId, agent }` 多槽；pairing 流程增加"绑定到当前登录用户"；普通用户只能使用绑定给自己的 relay。
- 文件面板走 relay `fs.*`，终端走 relay `pty.*`（均已存在）。
- 权限语义：用户本机的"目录权限"即 relay 共享根范围（现有 LocalMachinePanel 的共享目录概念），不需要服务器侧目录授权。

### 5.4 模式选择 UI
- 新建会话对话框增加模式选择（按角色过滤可选项）；会话卡片刻意标注模式徽章。
- 会话运行中不可切换模式（工具通道在会话创建时决定）。

## 6. 模型凭证（网关关闭方案）

LiteLLM 网关与"每用户虚拟键自动分配"**默认关闭**；平台需求 R4 保证关闭时不注入任何 `SANDBOX_LLM_*`。

P0 采用（二选一，默认前者）：
- **a. 统一供给**：沙箱/本机/Host 会话共用 pi-web 服务器配置的模型凭证；用量按会话统计（现有 session stats），不按用户密钥区分。
- **b. 用户自配**（可选开关）：设置页自填 provider API key，服务端加密存储、按会话用户选取。

若后期网关上线，再切换到平台虚拟键自动分配（保留接口，不在本期实现）。

## 7. 安全清单

- Web 会话 cookie：httpOnly + SameSite=Lax + Secure（HTTPS 部署时）；登出清 cookie 并撤销平台 refresh。
- CSRF：沿用 `lib/request-security.ts` 的同源校验并覆盖新增路由。
- 越权响应统一 404（不泄露存在性）。
- 平台令牌仅服务端内存/加密存储；日志脱敏。
- 本地 fs API / `/api/terminal`（Host 通道）在多用户模式下仅 admin 会话可达，服务端按会话模式路由强制拒绝。
- relay pairing 配对码一次性 + 绑定用户后不可转移（管理台可解绑）。
- 登录接口速率限制（平台已有，pi-web 登录代理层再加一道）。

## 8. 分期计划

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0 门户化** | 登录页 + cookie 会话 + BFF；会话空间分片 + 空间切换器 + 全路由归属校验；三模式框架（沙箱=扩展注入+禁本地回退；本机=单 relay 绑定 admin/单用户验证链路；Host=现状收口为 admin）；文件面板沙箱数据源；模型凭证统一供给 | 平台现状即可（无新需求） |
| **P1 补全** | 多 relay 并存 + pairing 绑定用户；沙箱容器选择器；平台 PTY WS 接入（终端三模式齐）；用户自配模型凭证（可选） | 平台 R2（PTY） |
| **P2 增强** | workspace 共享/ACL；网关若上线启用密钥自动分配；按用户用量报表 | 平台 R5/R8 等 |

## 9. 已识别风险

1. **单进程多会话**：所有用户的 agent 会话在 pi-web 单 Node 进程（内存/上下文压力）。教学规模（几十并发）可接受；上量前需按蓝图拆执行面或限制每用户并发会话数。
2. **CLI 会话写全局目录的竞争**：Host 空间与用户分片物理同根，需确保分片目录名（`users/`）不与现有编码 cwd 目录冲突（现存目录均为 `--encoded-cwd--` 形式，无冲突）。
3. **relay 多槽改造**：现注册表多处假设单 agent（状态推送、forward），需系统性梳理。
4. **平台 Demo 成熟度**：需求文档中的稳定性项（R3/R7）应在 P0 前置评审。
