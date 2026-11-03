# pi-web Agent 框架技术检视（PPT 资料底稿）

> 2026-11-03 · 范围：`pi-web-0851`（dev-0.85.1，提交 `01315ee4`）＋ `sandbox-platform`
> ＋ `agent/`（Go relay）。方法：代码事实 + `docs/dev/*` 设计文档 + `harness-research/*`
> 既有评估；只做检视与建议，不改代码。
>
> 用途：作为对外介绍/PPT 的事实底稿。文中"现状"均可指到文件；"差距"区分
> **框架能力缺口**与**产品取舍**，避免把有意选择当成缺陷。

---

## 0. 一页结论

**已建成的核心**：一个"浏览器里的 Agent 工作台"——会话编排在 pi-web 进程内，
工具执行面可按 **5 种模式**切到服务器 / 沙盒容器 / 用户本机 / 远程 SSH / 无工作区，
上层的项目、配置、会话、子智能体、评测 API 全部复用同一套会话模型。

| 维度 | 数字/事实 |
| --- | --- |
| 连接模式 | 5 种（host / sandbox / local-machine / ssh / quick），另有 Host 目录注册表 |
| API 路由 | `app/api/**/route.ts` 共 **173** 个 |
| 内置工具 | 7 件套（read/write/edit/bash/grep/find/ls）在所有远程模式被整体替换 |
| 核心扩展 | todo · plan_save · plan-mode · path-guard · context_status · bg-shell · provider-session-id |
| 实时通道 | 8 条 SSE + 3 条 POST 命令族 + 2 条机器侧 WS（详见 §5） |
| 配置层 | 全局 agentDir + 项目 home `.pi/`（+ quick 模板快照）；**没有用户中间层** |
| 多用户隔离 | 会话分片目录 + 注册表/metas 双账本 + 路径栅栏；容器/工作区由平台 owner 隔离 |
| 评测 | 批量 API（per-user 并发 4）+ bench harness + deep-swe 评测链 |

**三个最值得在 PPT 里讲的差异化**：

1. **模式抽象彻底**：模式只替换"工具执行层"，会话/子智能体/计划/文件面板/评测
   API 全部与模式解耦；新增一种执行面不需要复制会话逻辑。
2. **失败显式化**：远程模式缺通道/容器/agent 时**禁止静默回退到 Host**——这是
   `bg_run` 曾经在服务器上执行的真实事故换来的不变量（`docs/dev/session-access-and-tool-bridge.md`）。
3. **配置即交付物**：项目 `.pi/` 可导出/导入/加密（`.apkg`）、可做管理员预置模板、
   可随包携带 `node_modules` 与 builder 技能——"Agent 定义"本身是一个可版本化制品。

**三个最大的框架级差距**（§9 详述）：

1. **控制面没有隔离**：项目级 MCP stdio server 与 `.pi/extensions` 在 **pi-web 服务器
   进程内**启动；项目信任只是"用户点同意"，不是租户边界。数据面（7 工具）隔离，
   控制面（扩展/MCP）没有。
2. **运行时是单进程**：所有用户的 AgentSession 在同一个 Node 事件循环里；交互会话
   没有每用户并发/资源上限（批量 API 有），长任务无 checkpoint/续跑。
3. **记忆/编排/观测三层缺位**：无长期记忆与检索、无 ACP/多根/跨项目子代理、无
   OpenTelemetry 级追踪与工具级审计。

---

## 1. 架构总览

### 1.1 三平面

```
┌───────────────────────────── 浏览器（Next.js 前端）─────────────────────────────┐
│ 会话树 / ChatWindow / 文件面板 / 终端 / Plan / Agents / 设置 / 教学             │
└───────────────┬───────────────────────────────────────────────┬─────────────────┘
                │ HTTP + SSE（cookie 会话，BFF 边界）             │
┌───────────────▼───────────────────────────────────────────────▼─────────────────┐
│ pi-web（Next.js 单进程）                                                         │
│  ┌─ 控制面 ───────────────────────────────────────────────────────────────────┐  │
│  │ 认证/会话空间 · 项目/配置 · 会话注册表 · 计划/子智能体 · 评测 · 分享       │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
│  ┌─ 运行时 ───────────────────────────────────────────────────────────────────┐  │
│  │ AgentSession（pi SDK，cwd=项目 home） × N，共享一个 Node 事件循环           │  │
│  └───────┬──────────────────────────────┬──────────────────────────────┬──────┘  │
│          │ 工具层（按会话注入）           │ 通道层（按会话注册）          │       │
│   ┌──────▼──────┐  ┌──────────────┐  ┌──▼───────────┐  ┌──────────────┐        │
│   │ sandbox     │  │ relay tools  │  │ bg-channel   │  │ MCP adapter  │        │
│   │ tools       │  │ (local)      │  │ (remote)     │  │ (host 进程)  │        │
│   └──────┬──────┘  └──────┬───────┘  └──┬───────────┘  └──────┬───────┘        │
└──────────┼────────────────┼─────────────┼─────────────────────┼────────────────┘
           │ REST           │ WS JSON-RPC │ 同上                 │ stdio/http
     ┌─────▼─────┐    ┌─────▼─────┐  ┌────▼──────┐        ┌─────▼──────┐
     │ platform  │    │ Go agent  │  │ ssh2      │        │ 第三方 MCP  │
     │ container │    │ (用户机器) │  │ (远程主机) │        │ server     │
     └───────────┘    └───────────┘  └───────────┘        └────────────┘
```

### 1.2 四条关键不变量

1. **SDK 会话 cwd 恒为服务器侧项目目录（projectDir）**——配置、Skills、AGENTS.md、
   `.pi/` 从这里加载。远端工作区只是"工具操作的文件系统"，绝不作为 SDK cwd
   （`lib/session-context.ts` 的目录契约；历史 bug：把 `D:\…` workdir 当 cwd 写进
   会话头，恢复即崩）。
2. **模式只换工具层**：`sandbox-tools` / `relay-tools` / `ssh-tools` 以同名
   `registerTool` 覆盖七件套；会话、计划、子智能体、评测不看模式。
3. **远端能力必须显式注册通道**：`bg_run` 等触达宿主 OS 的能力按 sessionId 注册
   channel；`remote` 且无通道 → 报错，绝不回退本地（§5.5）。
4. **配置层与数据层分离**：`.pi/` 是配置（可分发），`/workspace` 是数据（可快照/
   云盘）；两侧只做显式 seed/export，不做后台双向同步（`docs/dev/PLATFORM.md`）。

---

## 2. 连接模式：五种执行面

### 2.1 模式矩阵

| | host | sandbox | local-machine | ssh | quick |
| --- | --- | --- | --- | --- | --- |
| 可用者 | 仅 admin（auth-off 隐式 admin） | 登录用户 | 登录用户（需配对 agent） | 登录用户（项目带 SSH 配置） | 登录用户 |
| SDK cwd（服务器） | 服务器真实目录 | 项目 home | 项目 home | 项目 home | 每会话 scratch/模板版本目录 |
| 工具执行位置 | 服务器本地 | 平台容器 `/workspace` | 用户机器（relay） | 远程主机（ssh2） | **无内置工具** |
| 工具通道 | SDK 内置 | 平台 REST `/containers/:id/tools/*` | WS JSON-RPC `fs.*/exec.*` | ssh2 exec/sftp | 仅 MCP 白名单 |
| 文件面板 | `/api/files` | `/api/remotefs` → 平台 | `/api/remotefs` → relay | `/api/remotefs` → sftp | 无工作区 |
| 终端 | 本地 PTY | 平台 PTY WS | relay PTY | ssh2 `shell()` | 无 |
| 后台任务 | 本地 spawn | 平台 tools/bash | relay exec.run | ssh exec | 无 |
| 会话文件空间 | admin 分片（CLI 在 host 空间） | 用户分片 | 用户分片 | 用户分片 | 用户分片 |
| 主要失败模式 | 无（服务器本地） | 容器未起 → 显式报错 | agent 离线/版本旧 → 426/错误 | 配置缺失/连接失败 → 错误 | 模板缺失 → 400 |

### 2.2 Host 模式

- 本质：管理员在**服务器真实目录**里跑会话；工具就是 SDK 内置实现。
- 目录没有项目记录：侧栏按 `projectRoot` 动态聚合；2026-11-03 增加**独立
  host-dirs 注册表**（`lib/host-dirs.ts` + `/api/host/dirs`）让"新建 Host 项目"
  在没有会话时也显示空组；删除只删占位，绝不删真实目录。
- 适合：维护服务器本身、跑 CLI 同款环境、没有容器/远端的场景。

### 2.3 Sandbox 模式

- 项目 home 的 `.pi/sandbox-platform.json` 携带 `url/apiKey/containerId/
  disableLocalFallback`；`sandbox-tools` 扩展在 `session_start` 读取，工具调用
  转发平台 `POST /containers/:id/tools/{bash,read,write,edit,grep,find,ls,access,stat}`。
- 路径映射：`toContainerPath` 把 win32 盘符路径、`workspace/x` 双前缀、host 绝对
  路径统一还原成容器内 `/workspace/...`（`sandbox/paths.ts`）。
- 容器按项目绑定（一个容器只属于一个项目）；容器未创建时**禁止本地回退**
  （多用户下的容器逃逸防线）。
- 挂载：`/input` 只读输入、`/output` 实时绑到用户「我的工作区」；`/workspace`
  是草稿区（`environment-info` 会把三者写进提示词）。
- 快照：平台 save/restore（FIFO 2 份/容器），恢复可回原容器或新容器；云盘
  workspace 显式 seed/export（`PLATFORM.md` §7）。

### 2.4 Local-machine（relay）

- 浏览器 → pi-web → Go Agent（独立 WS :30142，token 鉴权）；浏览器永不直连本机。
- 配对：6 位一次性码（5 分钟）→ 换 32 字节 token（90 天滚动、0600、服务端
  `relay.json`）；token 绑定 `(userId, machineId)`，多机多槽（`lib/relay/registry.ts`）。
- 工具：`relay-tools` 用七件套同名覆盖；路径策略二选一——agent ≥0.2.0 用每次
  RPC 的 `base`（任意绝对 workdir），旧 agent 用共享根相对前缀；根外给出升级提示。
- 文件/终端：`/api/remotefs`、`/api/remoteterminal` 按 `RemoteSessionContext` 路由；
  二进制读取新增 `binary-read` 能力（base64），旧 agent 回退 `base64 -w0`。
- 能力协商：`hello.info.features`（workspace-base / binary-read）+ 客户端版本门
  （过低直接 426，不建项目）。

### 2.5 SSH

- 项目创建时写 `.pi/ssh.json`（0600，密码/私钥，绝不进配置包）；会话创建时
  `ssh-tools` 用 `ssh2` 连接池，七件套全部走 `exec`/`sftp`。
- 工作目录 `project.workdir`（默认 `/`）；`remotePath` 把相对路径拼到 workdir；
  路径空间与 sandbox 一样需要 `path-scope` 映射回项目 home 才能让策略生效。
- 终端：`lib/remote-terminal.ts` 用 ssh2 `shell()` 开交互通道（resize 用
  `setWindow`）。
- 注意：`workdir="/"` 时没有"工作区围栏"语义（路径护栏也不映射），适合"整台
  远程机都是工作区"的场景；要锁目录应设具体 workdir。

### 2.6 Quick

- 无工作区、无内置工具；模板固定 `systemPrompt` / `model` / MCP 白名单。
- 工作区按"模板 + 内容 hash"共享（`lib/quick-session.ts`）：同模板同版本复用目录，
  模板变更自动新目录；目录内物化 quick MCP 与模板快照（可追溯版本）。
- 工具面严格封闭：`quickToolSet` 只放行白名单服务器前缀 `<server>_` 的工具，
  网关元工具/编码工具/子智能体一律不放行；每回合重新钳制（防 adapter 复活）。
- 适合：一次性问答、MCP 工具编排的轻量入口；不适合需要文件/命令的任务。

### 2.7 生命周期与失败语义

- 模式在**会话创建时**确定，运行中不可切换（工具通道在启动时装配）。
- 恢复会话时 `restoreSessionOptions` 按 sidecar meta 重建同一套模式扩展/
  通道/凭据目录——这是"刷新页面后沙盒会话不会变成 Host 会话"的关键。
- 失败语义：容器未起、agent 离线、通道缺失、SSH 配置缺失都返回**明确错误**；
  远程模式绝不静默降级到服务器本地（`session-access-and-tool-bridge.md` §2.4）。

---

## 3. 工具设计

### 3.1 七件套的"同名覆盖"

| 工具 | Host/Quick | sandbox | local-machine | ssh |
| --- | --- | --- | --- | --- |
| read | SDK 内置 | 平台 read（base64 媒体） | relay `fs.read` | sftp read |
| write | SDK 内置 | 平台 write | relay `fs.write` | sftp write |
| edit | SDK 内置 | 平台 edit | relay 读改写 | sftp 读改写 |
| bash | SDK 内置 | 平台 bash（容器内） | relay `exec.run`（argv，bash -c 包装） | ssh exec |
| grep | SDK 内置 | 平台 grep | relay `search.grep` | ssh grep |
| find | SDK 内置 | 平台 find | relay `search.fd` | ssh `find` |
| ls | SDK 内置 | 平台 ls | relay `fs.list` | sftp readdir |

设计要点：

- **同名覆盖**让模型提示词、工具选择、权限判定、会话恢复全部不感知模式；
  新增执行面只需实现同一组 `*Operations`（sandbox 的做法）或同名 `defineTool`。
- **路径归一化在工具层完成**：模型仍看到"普通路径"，由模式层翻译成容器/relay/
  sftp 路径；`environment-info` 把真实工作区写进提示词，避免模型把服务器 home
  当作用户目录。
- **能力协商**：relay 的 `workspace-base`/`binary-read`、客户端版本门；旧 agent
  得到可操作提示而不是静默错路由。

### 3.2 工具选择与预设

- 预设：`none` / `read-only` / `default`（read/bash/edit/write）/ `full`（7 件套）。
  `lib/tool-presets.ts`；会话选择持久化在 session custom entry
  （`pi-web:tool-selection`），恢复后仍生效。
- 快速会话不使用预设：`quickToolSet` 是封闭世界，模板 MCP 白名单是唯一放行面。
- 子智能体工具（Agent/get_subagent_result/steer_subagent）由 tintinweb 扩展提供；
  quick 明确排除。

### 3.3 核心扩展工具（CLI 与 WebUI 共用）

`pi-config/agent/extensions/amedac-core` 是单一事实源，CLI 与 pi-web 通过全局
agentDir（或仓库兜底路径）加载同一份：

| 扩展 | 作用 | 关键点 |
| --- | --- | --- |
| `todo` | todo 工具 + 双阈值 nudge + 验证提醒 | 状态在会话条目/工作区文件，不依赖进程内存 |
| `session-plan` | `plan_save` 写计划文件 | WebUI 统一 plan 端点读，CLI 走文件 |
| `plan-mode` | enter/exit_plan_mode + 只读工具门禁 | 计划期间 `tool_call` 硬门禁；退出三选一（直接/清上下文/继续） |
| `path-guard` | write/edit/read/bash 等路径策略 | 自保护 → deny → 决策 → allow → 区外询问；远程模式用 scope 映射 |
| `context-status` | `context_status` 只读工具 | token/窗口/余量，≥80% 给收敛建议 |
| `bg-shell` | `bg_run/bg_list/bg_stop` | 本地 detached spawn；远程走注册 channel；输出落 `.pi/tmp/bg` |
| `provider-session-id` | 会话亲和元数据 | litellm_session_id / x-session-id 三头 |
| `sandbox tools` | 条件注册 | CLI 目录带 sandbox 配置才加载；WebUI 内联注入 |

### 3.4 桥接/模式扩展

- `environment-info`：每回合 `before_agent_start` 注入"你在哪、工作区在哪、配置在
  服务器侧"；local/ssh 还会把系统提示词的 `Current working directory` 改写成工作区。
- `remote-verify`：把实验室验证的文件/命令操作桥到容器/relay（`globalThis.__piWebRemoteVerify`）。
- `share_file`：host 活引用 / 远程快照；模型拿到 bearer URL 交给 MCP，而不是把文件
  内容塞进自己的输出（`docs/dev/mcp-file-sharing.md`）。
- `bg-tasks`：把浏览器 `stop_subagent` 转发到 tintinweb 的会话内事件总线。
- `subagent-bridge`：子会话按父会话模式取回同一套内联扩展（`__piWebChildExtensions`），
  避免"子智能体在 Host 上跑"。

### 3.5 MCP

- 适配器 `pi-mcp-adapter`（锁定 2.31.0）；配置三 scope：global（`~/.pi/agent/mcp.json`）、
  project（`<cwd>/.pi/mcp.json`）、quick（部署级 `data/mcp-quick.json` 物化）。
- 工具命名 `<server>_<tool>`；`directTools` 可直接暴露，否则走 mcp 网关工具。
- **已知边界（重要）**：MCP server 在 **pi-web Host 进程内**启动（stdio）或由 Host
  访问（http），不在 sandbox/relay/ssh 执行面内。提示词不承诺"远端执行"；远端
  MCP 隧道未做（`session-access-and-tool-bridge.md` §2.4）。
- 设置页：单服务器启停、分组开关、测试连接、全局设置（idleTimeout 等）、
  项目级墓碑覆盖（`target=project`，`docs/dev/mcp-scopes-and-overrides.md`）。

### 3.6 权限与护栏

- **path-guard**：行为护栏（不是安全边界）。自保护清单恒生效；deny/allow +
  "不再询问"决策随配置包分发；远程模式用 `.pi/path-policy.scope.json` 做路径
  空间映射；bash 覆盖写命令操作数/重定向/cd/内联执行兜底；MCP/解释器脚本/变量
  展开仍可绕过（`docs/dev/path-policy-guardrails.md`）。
- **plan-mode**：计划期间只读工具白名单；退出前询问。
- **project trust**：仓库 `.pi/extensions`、`.pi/settings.json` 扩展条目、
  `.agents/skills` 由 SDK 信任门控；不覆盖 MCP。
- **MCP scope**：global/quick 写操作仅 admin；project 由项目属主管理。
- **模型配置**：全局 `models.json` PUT 仅 admin；GET 对普通用户脱敏
  （`app/api/models-config/route.ts`）。

---

## 4. 远程调用模式

### 4.1 四种 RPC 风格

| 执行面 | 协议 | 调用形态 | 超时/流式 | 鉴权 |
| --- | --- | --- | --- | --- |
| 平台容器 | REST `/api/v1/containers/:id/tools/*` | 每工具一次 HTTP | 平台侧超时；bash 有 stream 变体 | per-user `sk_` API key |
| 用户本机 | WS JSON-RPC（`RpcRequest/RpcResponse/RpcChunk/RpcEnd`） | 请求-响应 + chunk/end 流 | 30s 一次性、2min 流式 | 90 天滚动 token（0600） |
| SSH | ssh2 exec / sftp | 每工具一次 exec/sftp | 命令 timeout 参数 | 项目 `.pi/ssh.json`（0600） |
| Host | 进程内函数调用 | 直接执行 | SDK/工具自身 | 服务器权限（admin） |

### 4.2 路径映射三层

1. **工具路径 → 执行面路径**：sandbox `toContainerPath`（win32 盘符/双前缀/host
   绝对路径）；relay `toRelayPath`（base/prefix）；ssh `remotePath`（workdir 拼接）；
   remotefs 用虚拟根（项目 home 绝对路径 ↔ workdir 相对路径）。
2. **策略路径**：`path-guard` 用 `path-scope` 把远端工作区根映射回项目 home，
   让相对 deny/allow 规则在四种模式语义一致。
3. **提示词路径**：`environment-info` 明确 projectDir vs workspaceDir，并改写
   "Current working directory" 行，避免模型把配置目录当工作区。

### 4.3 失败语义与能力协商

- relay：`hello.features`（workspace-base / binary-read）+ `agentVersion`；过低
  版本在配对/建项目时直接拒绝（426）；工具调用时 `requireCompatibleAgent` 再校验。
- sandbox：`disableLocalFallback` 时容器不可用直接抛错；bg-channel 无容器时只标
  `remote`，调用时报"通道未就绪"。
- ssh：配置缺失/连接失败/命令非零退出都有明确错误；`exec` 超时参数由工具传入。
- 统一原则：**远端不可用 = 显式失败**，不静默换执行面。

---

## 5. 通道设计

### 5.1 通道清单（以 `harness-research/08` 为基线，后随功能新增）

**下行 SSE（8 条）**：agent events（主通道）、batch 任务流、本地终端、远程终端、
relay 终端、relay 状态、OAuth 登录等待、文件 watch。
**上行 POST（3 族）**：`/api/agent/[id]`（约 30 个命令）、终端 create/input/resize/close、
relay RPC（含 `/rpc/stream` SSE 变体）。
**机器侧（2 条）**：relay WS `/ws?token=`（30142）、relay 下载代理。

工程化现状：

- `lib/sse-stream.ts`（P1 已落地）：心跳、abort、`X-Accel-Buffering: no`、
  进程关闭注册表；fork 自有四条流已迁移，SIGTERM 不再脏断连。
- **主事件流仍无 seq/重放**（doc 08 P2）：断线靠 snapshot 补偿，存在事件丢失窗口；
  batch 流已有 seq 信封 + 500 条环形缓冲，是统一格式的规范来源。
- 帧格式五种并存（裸事件 / seq 信封 / 终端三帧 / chunk / 状态），上行无统一客户端层。
- 终端流在 fork 重写时丢掉了上游的 SSE `offset` Last-Event-ID 重放（doc 08 §1.0）。

### 5.2 会话事件主通道

- 服务器端 `AgentEventStream`：每会话一个快照发布器 + 订阅者 + liveness lease；
  30s 心跳；关闭注册表让发版时客户端收到干净错误帧。
- 客户端 `AgentEventConnection`：EventSource + 重连；断线后 `connected` 事件 +
  streaming snapshot 补偿（全量 state 兜底）。
- 评价：**够用但非可靠流**；高频工具事件/长会话在弱网下可能丢中间帧。改进方向
  是 doc 08 的 seq 信封 + 环形缓冲（与上游分叉成本需评估）。

### 5.3 终端三后端

| 模式 | 实现 | 关键点 |
| --- | --- | --- |
| host | node-pty 本地 PTY | 平台无关；SSE 输出 + POST 输入/resize/close |
| sandbox | 平台 PTY WebSocket 桥 | 平台侧 `PTY_MAX_PER_CONTAINER=3`；最后订阅者离开 60s 回收；30min idle 清扫 |
| local | relay `pty.create/input/resize/close` | agent 推送 pty.output 事件帧；registry 按 `${machineId}:${agentSid}` 分发给 SSE |
| ssh | ssh2 `shell()` | resize 用 `setWindow`；连接池复用项目连接 |

不变量（PLATFORM.md 的"黑屏教训"）：必须真 PTY（管道模式无提示符/回显）；
泄漏的 PTY 占全容器并发名额，订阅者清零后 60s 宽限强制回收。

### 5.4 后台任务通道

- 扩展侧：`bg_run` 每次调用**运行时解析** channel（不缓存）；`remote` 且无通道 →
  明确报错；本地 spawn 用 detached 进程组，输出落 `.pi/tmp/bg/<id>.log`。
- pi-web 侧：`startRpcSession` 在 **真实 session id**（SDK mint 后）注册
  mode + channel；新会话/恢复/子智能体三条路径都注册。
- 三后端：sandbox → 平台 tools/bash；local → relay exec.run；ssh → ssh exec。
- 局限：V1 不自动唤醒（模型自行 read 输出轮询）；重启后 `bg_list` 报 lost；默认
  1h 无消费者上限取消。

---

## 6. 项目管理

### 6.1 ProjectRecord 模型

```
ProjectRecord {
  id, name, ownerId, ownerName?, mode: sandbox | local-machine | ssh,
  createdAt, pinnedSessions[], containerId?, imageId?,
  workdir? (local/ssh), machineId? (local), ssh? (SSH 输入),
  presetBundle?, snapshotSlots?
}
```

- 存储：`<dataDir>/projects.json`（mtime 缓存，跨路由模块可见）。
- home：`<dataDir>/{sandbox,local}-homes/u<uid>/<projectId>/`；`.pi/` 是配置层。
- 同名约束：同一用户项目名唯一（侧栏分组/复制目标辨识）。

### 6.2 四种"项目"形态

| 形态 | 是否有记录 | 会话归属 | 配置层 | 删除语义 |
| --- | --- | --- | --- | --- |
| 项目（sandbox/local/ssh） | ✅ ProjectRecord | `projectId` | 项目 home `.pi/` | 删记录 + 删托管 home |
| Host 目录（动态） | ❌（按 cwd 聚合） | 无 projectId | 真实目录 `.pi/` | 末会话删除即消失 |
| Host 目录（注册表，2026-11-03） | ✅ host-dirs.json（占位） | 无 projectId | 真实目录 `.pi/` | 只删占位，不删目录 |
| Quick（模板组） | ✅ quick-templates + 会话快照 | 无 projectId | 每版本工作区 `.pi/` | 模板删除后组保留为 detached |

### 6.3 项目能力矩阵

| 能力 | sandbox | local-machine | ssh | host 目录 | quick |
| --- | --- | --- | --- | --- | --- |
| 新建时选配置模板 | ✅ | ✅ | ✅ | ❌（先选目录再套用） | ✅（quick 模板） |
| 项目级模型凭据（`.pi/models.json`/`auth.json`） | ✅ | ✅ | ✅ | ❌（走全局） | ❌ |
| 容器绑定/切换 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 快照/存档（容器） | ✅ | ❌ | ❌ | ❌ | ❌ |
| 导出/导入配置包 | ✅ | ✅ | ✅ | ✅（目录菜单） | ❌ |
| 复制项目（含 `.pi/` 快照） | ✅ | ✅ | ✅ | ❌ | ❌ |
| 项目设置（重命名/凭据/AGENTS.md） | ✅ | ✅ | ✅ | ❌（目录级导入/导出替代） | ❌ |
| 主机目录空组/重命名 | — | — | — | ✅（注册表） | — |

### 6.4 配置包体系

- 项目配置包：`.pi/` + `labs/` + 根 AGENTS.md → zip；导出剥离 `auth.json/
  ssh.json/sandbox-platform.json/path-policy.scope.json`；导入前 schema 校验
  `mcp.json`/`models.json`（失败不落任何文件）；`node_modules` 可随包（离线）。
- 预置模板：`data/config-bundles/<name>.zip|.apkg`；管理员上传，用户在向导选；
  项目创建后也可"套用配置模板"（叠加覆盖）。
- 加密包 `.apkg`：KEK 存 `apkg-keys.json`（0600），解密面外置为内部二进制
  （公开仓零加解密代码）；导入失败不写文件；`.bundle-lock.json` 防再导出。
- 版本：manifest v2 `package.version`；内置 Agent Builder 1.1.3；无签名/无
  semver 校验（P3 已知不足）。

---

## 7. 多用户与配置管理

### 7.1 身份与登录

- pi-web 不自建账号：登录代理平台 `POST /api/v1/auth/login`，成功后为该用户
  **铸造一枚长寿命 `sk_` API key** 存服务端 WebUI 会话；浏览器只拿 HttpOnly
  cookie，不接触平台 token。
- cookie：`SameSite=Lax`，滑动 7 天（`PI_WEB_SESSION_IDLE_DAYS`）、绝对 90 天
  （`PI_WEB_SESSION_ABSOLUTE_DAYS`）；每请求校验 + 每小时 touch。
- auth-off（`PI_WEB_AUTH=off`）：隐式 host admin（id=0），单用户形态。

### 7.2 会话三账本与栅栏

```
运行时注册表（__piSessions，最权威，重启即空）
  > session-metas.json（mode/ownerId/projectId/quickDir，mtime 失效重载）
    > URL/space 参数
```

- 会话空间：host 空间（CLI）与 `sessions/users/u<id>` 分片；隔离 = **路径栅栏**
  （解析结果必须在空间目录内，否则 404 不泄露存在性）。
- 活会话快路径：`checkLiveSessionAccess` 只允许 owner 或 admin；普通用户拿别人
  运行中 id 读/写一律 404。
- 管理员跨用户：**运行中**会话默认为**只读支持视图**（可看事件/状态，不能
  prompt/steer/abort/set_*）；点"接管"后 1 小时内可写（按 (session, admin)
  记内存，页面刷新/进程重启失效）。已落盘的历史会话仍走空间栅栏（404）。
- 平台资源：容器/workspace 按 owner 隔离（平台 404 原则）；relay 按
  `(userId, machineId)` 多槽；项目按 ownerId 校验。

### 7.3 配置分层

```
全局层  ~/.pi/agent/                （admin 管理：models.json/auth.json/扩展/Skills/settings）
   ▲ 合并（pi 原生）
项目层  <projectHome>/.pi/           （项目属主：settings/agents/skills/extensions/mcp/models/auth）
   ▲
Quick   <quickHome>/q-<template>-<hash>/.pi/  （模板快照 + quick MCP 物化）
```

- **没有用户中间层**：普通用户通过"复制项目"派生自己的配置集；全局层变更不会
  自动进入已有项目（项目 `.pi/` 是创建/复制时的快照）。
- 模型凭据：全局 `auth.json`/`models.json` + 项目 `.pi/auth.json`/`models.json`
  覆盖（`projectCredentialDir`）；沙盒模式还可由平台 LLM 网关自动注册 provider
  （LiteLLM 虚拟键，`sandbox/llm.ts`）。
- 工作区偏好：`.pi/web-preferences.json`（mcpEnabled/subagentsEnabled/labVerify）
  是**工作区共享**，不是每用户；每用户设置只有 `askAutoContinue`
  （`data/user-settings/u<id>.json`）。
- 权限：全局 plugins/agents/mcp/models 写操作仅 admin（`resolveConfigCwdSync` +
  scope 校验）；项目 scope 由项目属主。

### 7.4 配额与限流

| 资源 | 机制 |
| --- | --- |
| 容器/CPU/内存/磁盘/镜像 | 平台 `resource_quotas` + `images.max_per_user`（正交两道检查） |
| 批量任务 | 全局 `PI_WEB_BATCH_MAX_CONCURRENT` + 每用户 `PI_WEB_BATCH_USER_MAX_CONCURRENT`（默认 4，admin 豁免） |
| 配置包上传 | 默认 2048MB，>200MB 二次确认（`lib/server-settings.ts`） |
| 分享文件 | `PI_WEB_SHARE_MAX_BYTES` 默认 100MB |
| PTY | 平台 `PTY_MAX_PER_CONTAINER=3` |
| 交互会话 | **无每用户上限**（见 §9 差距） |

---

## 8. 项目-会话层级

### 8.1 三空间

- **我的会话（mine）**：项目 + 未绑定模式组（pre-project sandbox/local）+ Host 目录组。
- **Host（admin）**：CLI 与服务器目录会话（按 projectRoot 动态分组；Host 目录
  注册表的空组也在此显示）。
- **快速（quick）**：按模板版本两级分组（模板名 + hash → 会话）。

### 8.2 树的层级

```
项目（mode 徽标 / 容器状态点 / 会话数 / ＋新建 / ⋮菜单）
└─ 会话（置顶★ → 最近 5 条 → 显示全部；运行态、未读、重命名/删除）
   └─ 子智能体会话（缩进 + ⌘；父会话不在列表时隐藏）
```

- Host 目录组：`Host` 徽标 + 末级目录名（tooltip 全路径）+ 会话数 + ＋ + ⋮；
  注册表空目录显示"还没有会话——点 ＋ 在这个目录新建一个"。
- Quick 组：模板名 (hash) + 模板已删除徽标 + ＋（仅未 detached）。
- 折叠状态持久化 localStorage；置顶存 ProjectRecord.pinnedSessions。
- 会话家族（`lib/session-family.ts`）把 fork/子智能体归到 root，侧栏按家族展示。

### 8.3 层级设计的优点

- 三种"项目"形态用同一棵树呈现，用户心智一致；空项目/空目录/空模板都有明确空态。
- 项目是配置载体，会话是执行实例；置顶/折叠/搜索是纯视图状态，不污染配置。
- 子智能体不是"另一棵树"，而是父会话的缩进子行，避免目录爆炸。

### 8.4 层级的缺口

- 没有"跨项目会话"或"会话移动/归档"；项目删除后的会话归属未定义（随 home 删除，
  历史会话文件仍在 shard 里但侧栏不再分组）。
- 没有标签/文件夹/多级分组；项目多时只能靠搜索/折叠。
- 管理员的支持视图没有"只读/归属"标识（§7.2）。
- Host 目录注册表是占位，不具备项目级凭据/复制/快照（有意取舍）。

---

## 9. 与"完善 Agent 框架"的差距

参考能力模型（12 层）与现状对照。**优先级**：P0=安全/正确性，P1=框架能力，
P2=体验/规模化；**工作量**为粗估（人日）。

### 9.1 执行与调度

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 所有 AgentSession 在 pi-web 单 Node 进程；交互会话无每用户上限；批量有并发门 | 无 worker/多进程、无交互会话配额、无背压；事件循环被同步 fs/大 payload 阻塞（性能分析：20MB≈75-150ms） | 会话运行时 worker 化（每 worker N 会话，IPC 复用 RPC）；加每用户交互会话上限与排队；把阻塞型 fs 换 async | P1 / 5-10 |
| 长任务：bg_run 不自动唤醒、重启 lost；工具调用不可恢复 | 无 checkpoint/续跑；无 at-least-once 任务语义 | bg 终态注入 `<task-notification>`（V2）；会话级 checkpoint（消息树已有，补工具状态）；重启后 bg_list 标 lost + 可重跑 | P1 / 3-5 |
| 会话恢复靠文件 + sidecar；运行中流断线靠 snapshot | 事件流无 seq/重放；跨重启丢失 in-flight 事件 | doc 08 P2：主事件流 seq 信封 + 环形缓冲；或客户端缓冲 + state 重取（零分叉降级） | P1 / 2-3 |

### 9.1b 会话生命周期与 500 并发推演

**一个回合结束后**：`AgentSessionWrapper` 不会立刻销毁；它回到 idle，重置
`SESSION_IDLE_TIMEOUT_MS`（代码默认 10 分钟；VM 部署常见 `PI_WEB_IDLE_TIMEOUT_MS=7 天`）。
idle 期间**不占 CPU**，但会占内存（消息/工具结果对象）与一个定时器；超时后
`shutdown()` 发出 `session_shutdown`、`dispose()` 并从注册表移除，下次访问从
JSONL 恢复。因此"对话结束后一直占用事件循环"不成立——但**内存驻留**是真实成本。

**50 用户 × 每人 10 个打开会话 = 500 个驻留会话**：

| 资源 | 估算 |
| --- | --- |
| 会话内存 | 10–50MB/活跃 RPC 会话（容量文档实测 1MB 磁盘≈3MB 堆）；500 × 15MB ≈ 7.5GB 起，按 30MB 则 15GB |
| 模型并发 | 硬顶是模型侧（例：Qwen3.8-27B @ 2×H100 ≈15 并发回合）；500 个**同时**生成会排队/超时 |
| 事件循环 | 500 个 idle 会话本身不压 CPU；500 条 SSE + 同时流式输出才是瓶颈；JSONL 恢复（20MB≈75-150ms）会造成登录潮卡顿 |
| 磁盘 | 会话写盘与快照/容器盘叠加，需单独配额 |

结论：**单机单进程不支持 500 个同时活跃会话**。可行的分层：

1. **每用户交互会话上限**（例如 5）＋ "超过后最旧 idle 会话被卸载（LRU）"；
2. **worker/进程池**：每 worker 承载 N 个会话（`pi --mode rpc` 子进程），
   把 JSONL 解析与模型流移出主事件循环，按用户/会话哈希路由；
3. **模型调用排队**（按部署模型并发设上限）+ 每用户 token/成本配额；
4. 缩短 idle TTL（默认 10 分钟）或按"打开标签页"续命，而不是 7 天常驻；
5. 500 **用户** ≠ 500 **活跃会话**：按 20-30% 活跃比，50 用户×10 会话的
   实际同时生成通常在 10-20 个回合，单机尚可；但 500 个"打开着"的会话仍
   需要上面的内存治理。

### 9.2 环境与依赖

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| `bundle.json.dependencies` 仅展示；扩展 node_modules 可随包；离线 pip/npm 方案已设计未实现 | 依赖契约不可执行；运行时装包在离线环境失败 | 落地 `agent-environment-dependencies.md` L1-L5：结构化依赖 schema → vendor 打包 → 会话 bootstrap → 镜像重依赖 → 镜像源 | P1 / 5-8 |
| 沙盒镜像只读层 + 工作区 venv 方案 | 无镜像构建流水线文档化/校验 | 平台镜像构建模板 + `kind:image` 依赖声明校验 | P2 / 3 |

### 9.3 模型与凭据

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 全局 models/auth + 项目覆盖 + 沙盒 LLM 网关自动注册；模型 scope/enabledModels | 无每用户模型配额/成本账本；无模型路由/降级策略；无 prompt cache 纪律 | 每用户/项目 token/成本统计（session stats 已有基础）；模型 fallback 链；缓存友好提示词模板 | P1 / 3-5 |
| ~~**全局凭据写接口权限不一致**~~（**已修 2026-11-03**）：`auth/api-key|login|logout`、`models-config/test|discover` 现在都要求登录并按角色分 scope；普通用户写入 `<dataDir>/user-models/u<id>/`，管理员写全局 | 已修：普通用户不再能改全局凭据；用户模型配置与会话运行时合并（全局→用户→项目） | 后续：每用户模型成本配额、模型 fallback 链 | 已落地 |

### 9.4 工具与 MCP 治理

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 七件套同名覆盖 + 预设 + path-guard + plan 门禁 | 无 per-tool 审批策略（allow/ask/deny 只到路径层）；无工具级审计；无动态工具发现（tool_search） | 工具策略表（按工具/模式/角色）；tool_call 审计事件（谁/会话/工具/参数摘要/结论）；工具多时再加 tool_search | P1 / 3-5 |
| MCP 在 Host 进程启动；project scope 由项目属主管 | 控制面未完全隔离：项目 `.pi/mcp.json` 的 stdio command 在服务器执行 | **已修一部分（2026-11-03）**：普通用户的项目 stdio 创建/更新/配置包导入被拒；project trust 纳入 `mcp.json` 并给出可操作的信任提示。**剩余**：已存在的 stdio 条目与管理员模板仍在 Host 执行，彻底方案是把 MCP 放进执行面 | P0 部分已落地 / 剩余 P1 2-4 |
| `.pi/extensions` 由 SDK 信任门控，但用户可自行信任 | 用户项目扩展在 Host 进程执行；信任是同意不是沙箱 | 扩展权限声明（capabilities）+ 进程隔离/受限 API；或仅 admin 可加载项目扩展 | P1 / 5-8 |

### 9.5 记忆与知识

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 会话文件 + AGENTS.md + Skills；无长期记忆 | 无跨会话记忆、无 RAG/知识库、无记忆写入/检索工具 | workspace memory（`.pi/memory/*.md` + 检索工具）；项目知识库索引；记忆写入需用户确认 | P1 / 5-10 |

### 9.6 编排与协议

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| tintinweb 子智能体（静态 profile，父子同 cwd）；plan/todo 有 | 无跨项目子代理、无多根工作区、无 ACP、无工作流/DAG/定时任务 | ACP 适配层（harness-research/06 Phase1）；多根 allowed-roots（Phase2）；跨项目子代理 cwd 覆盖（Phase3）；定时任务接平台 | P2 / 3-5 each |

### 9.7 治理与审计

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 会话归属/路径栅栏/项目 owner/平台配额；path-guard 有 onVerdict 钩子但无持久审计 | 无工具级/管理操作审计；管理员支持视图已默认只读（接管留痕待补）；无数据保留/删除策略 | 统一 audit log（tool_call、审批、管理员访问、配置包导入）；管理员支持视图只读 + 显式接管；保留策略 | P0（只读视图）/ P1（审计）/ 2-4 |
| 平台有 sessions/audit 表 | pi-web 侧事件未汇入 | 结构化事件 → 平台或本地 JSONL + 查询页 | P1 / 3 |

### 9.8 可观测性与评测

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| session stats（token/成本/上下文）、运行态、日志；batch/bench/deep-swe | 无 OTel/trace、无工具级指标、无告警；无 CI 真模型回归/金标回放 | OpenTelemetry（session/tool/model 三段 span）；指标端点；bench 进 CI（离线模型/固定回放） | P1 / 5-8 |
| 评测：批量 API + bench + deep-swe | 无工具使用正确率、无回归门、无 A/B | 金标会话回放；工具选择/路径/审批的单元评测 | P1 / 3-5 |

### 9.9 生命周期与协作

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 会话 fork/clone、导出 HTML、自动命名、搜索、置顶、分享文件 | 无 checkpoint/rewind（代码级）、无会话共享/协作、无评论/交接 | 会话级 checkpoint（消息树已有，补代码快照）；只读会话分享；交接摘要 | P2 / 3-5 |
| 项目删除即删 home | 历史会话归档策略缺失 | 删除前导出/归档；软删除 | P1 / 1-2 |

### 9.10 分发与扩展生态

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 配置包 zip/apkg + 预置模板 + 加密 + schema 校验 + builder 技能 | 无签名/版本约束、无市场、无热加载、依赖契约未执行 | manifest 签名 + semver 校验；SkillHub/模板市场；扩展热重载；依赖 schema | P2 / 5-8 |
| pi-config 模板版本化 + 混淆 | 升级需重启；混淆非加密 | 可选：扩展 ABI/版本协商 | P2 |

### 9.11 部署与运维

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| tar/AppImage/Electron + 离线包 + 一键 start-all；单机 | 无 HA/多节点、无自动备份、无指标/告警、无灰度 | 多实例 + 共享 dataDir/会话路由；备份脚本；/metrics；灰度发布 | P2 / 10+ |
| 数据目录（PI_WEB_DATA_DIR）+ 配置版本 | 迁移/回滚脚本不完整 | 版本化迁移 + 回滚演练 | P2 / 3 |

### 9.12 UX 与多语言

| 现状 | 差距 | 建议 | 优先级/工作量 |
| --- | --- | --- | --- |
| 三语 i18n、设置页、聚光灯教学、移动工具栏 | 仍有硬编码中文（模式徽标/沙盒组标签等）；移动端功能缺口；无协作 | 清理硬编码键；移动端文件/终端补齐；协作只读分享 | P2 / 3-5 |

---

## 10. 优化路线图（建议）

**P0（1-2 周，安全/正确性）**

1. ✅ **已完成（2026-11-03）** 全局凭据/网络代理类路由的角色 scope：
   `auth/api-key|login|logout`、`models-config/test|discover` 都要求身份并按
   角色写入全局/用户层；普通用户的模型配置进 `<dataDir>/user-models/u<id>/`，
   会话运行时按「全局 → 用户 → 项目」合并。
2. ✅ **部分完成（2026-11-03）** 项目级 MCP：普通用户的 stdio 创建/更新/
   配置包导入被拒；trust 纳入 `mcp.json` 并在 AppShell/技能/插件/MCP 页给出
   "受限模式 + 信任项目"入口。剩余：已存在的 stdio/管理员模板需执行面隔离。
3. ✅ **已完成（2026-11-03）** 管理员支持视图默认只读 + 归属提示 + 1 小时
   接管开关（`/api/sessions/:id/takeover`）；写命令在 `POST /api/agent/:id`
   统一拦截。
4. ⬜ 每用户交互会话上限 + 全局上限（防单进程被拖垮）。

**P1（1-2 个月，框架能力）**

5. 运行时 worker 化 + 背压/排队；阻塞 fs 异步化。
6. 环境依赖 L1-L5（结构化 schema → vendor → bootstrap → 镜像）。
7. 工具策略表 + tool_call 审计事件（含 path-guard verdict 持久化）。
8. 主事件流 seq/重放（doc 08 P2）或客户端缓冲降级；终端 offset 重放。
9. 记忆层（workspace memory + 检索工具）与知识库索引。
10. 可观测性：OTel 三段 span + 指标 + 告警；bench 进 CI（离线回放）。

**P2（季度级，生态/规模化）**

11. ACP 适配层 + 多根工作区 + 跨项目子代理（harness-research/06）。
12. checkpoint/rewind（代码级）+ 会话只读分享/协作。
13. 配置包签名/版本约束 + 模板市场 + 扩展热加载。
14. 多节点/HA + 备份/迁移 + 灰度。
15. i18n 硬编码清理 + 移动端补齐。

---

## 11. PPT 结构建议（15 页）

1. **封面**：pi-web——浏览器里的多模式 Agent 工作台（一句话定位 + 5 模式图标）。
2. **问题**：Agent 要碰文件/命令，但"在哪执行、谁能看、怎么交付"没有标准答案。
3. **总体架构**：控制面 / 数据面 / 配置面 + BFF 边界（用 §1.1 图）。
4. **五种连接模式**：矩阵图（§2.1），突出"模式只换工具层"。
5. **工具层**：七件套同名覆盖 + 预设 + 核心扩展（§3.1/3.3）。
6. **远程调用**：REST / WS JSON-RPC / SSH / Host 四种风格 + 路径映射三层（§4）。
7. **通道设计**：13 条通道 + "远端不可用=显式失败" + bg 通道（§5）。
8. **项目管理**：ProjectRecord + 四种项目形态 + 配置包/模板/加密（§6）。
9. **多用户**：三账本/栅栏/配额/配置分层（§7）。
10. **项目-会话层级**：树形图 + 三空间 + 空态（§8）。
11. **关键设计决策**：cwd=projectDir、模式只换工具层、配置/数据分离、显式失败（§1.2）。
12. **与完整框架的差距**：12 层雷达/矩阵（§9）。
13. **安全边界**：数据面隔离 vs 控制面未隔离（MCP/扩展）+ P0 修复项（§9.4/9.3）。
14. **路线图**：P0/P1/P2 三列（§10）。
15. **结语**：已交付的能力 + 下一步邀请（演示/试用）。

> 讲稿提示：第 4/5/6 页是"技术硬核"，第 8/9/10 页是"产品形态"，第 12/13 页
> 是"诚实边界"——对外介绍时建议把 13 页作为"我们知道问题在哪"的加分项，
> 而不是隐藏。

---

## 12. 附录：关键文件索引

| 主题 | 文件 |
| --- | --- |
| 模式与权限 | `lib/session-modes.ts`、`lib/session-context.ts` |
| 会话启动/恢复 | `app/api/agent/new/route.ts`、`lib/session-restore-options.ts`、`lib/rpc-manager.ts` |
| 工具层 | `pi-config/agent/extensions/amedac-core/src/sandbox/*`、`lib/extensions/relay-tools.ts`、`lib/extensions/ssh-tools.ts` |
| 通道 | `lib/extensions/bg-shell.ts`、`lib/extensions/bg-channels.ts`、`lib/relay/*`、`lib/remote-terminal.ts`、`lib/sse-stream.ts` |
| 路径/护栏 | `pi-config/.../src/path-guard*.ts`、`docs/dev/path-policy-guardrails.md` |
| 项目/配置 | `lib/projects.ts`、`lib/config-cwd.ts`、`lib/config-bundles-store.ts`、`lib/project-config-bundle.ts`、`docs/dev/config-sharing.md` |
| 多用户 | `lib/web-session.ts`、`lib/session-spaces.ts`、`lib/session-access.ts`、`lib/session-metas.ts`、`docs/dev/multi-user-and-modes-design.md` |
| 层级 UI | `components/ProjectSessionTree.tsx`、`components/SessionSidebar.tsx`、`lib/host-groups.ts` |
| 平台 | `docs/dev/PLATFORM.md`、`docs/dev/CONNECT_LOCAL_MACHINE.md`、`sandbox-platform` 仓库 |
| 研究与路线 | `harness-research/06/07/08/09`、`docs/dev/agent-environment-dependencies.md`、`docs/dev/commercial-protection.md` |
