# 工具护栏设计：工具操作层声明与模式路由

> 目标：建立一套覆盖**所有工具来源**（内置 / amedac-core / pi-web 内联 / MCP /
> 用户扩展 / 子代理）的工具护栏，核心机制是**新工具引入时必须声明操作层**——
> 区分"宿主机直接执行、不涉及工作区内容（可直接引入）"与"作用于工作区内容
> （必须声明各远程模式下的执行方式）"。
> 现状参照：`path-policy-guardrails.md`（路径护栏）、`qwenpaw-guardrails-reference.md`
>（业界参照与教训）。
> 状态：**设计稿，待评审**。2026-11-05。

## 1. 现状与问题

工具装配事实（见 `lib/rpc-manager.ts`、`docs/dev/session-access-and-tool-bridge.md`）：

- agent 进程恒在 pi-web 服务器内；五种 `SessionMode`
  （`lib/session-modes.ts:6`：host/quick/sandbox/ssh/local-machine）只是工具层不同，
  靠**同名覆盖 + 通道注入**实现路由：
  - sandbox：7 个编码工具经平台 REST 进 Apptainer 容器（`amedac-core/src/sandbox/`）；
  - local-machine：经 relay WebSocket RPC 到用户机器（`lib/extensions/relay-tools.ts`）；
  - ssh：经 ssh2 exec/SFTP（`lib/extensions/ssh-tools.ts`）；
  - quick：封闭世界三层钳制（`quickToolSet`，`rpc-manager.ts:353-375`）；
  - host：SDK 内置工具直接执行。

当前护栏缺口：

| # | 缺口 | 位置 |
| --- | --- | --- |
| G1 | **MCP 是唯一漏网通道**：所有模式下 stdio/HTTP 都从 pi-web 服务器发起，不进容器/不上远端，path-guard 也不拦（`path-guard.ts:19-20` 明示） | `lib/mcp-probe.ts:21-29` |
| G2 | **bg_run 完全绕过路径护栏**：bash 里会被拦的 `rm .env`，改用 bg_run 即无检查（不在 `PATH_TOOLS`/shell 名单，`path-guard.ts:113` 直接放行） | `amedac-core/src/bg-shell.ts:444` |
| G3 | **拦截名单硬编码**：path-guard 只认 `bash/powershell + read/write/edit/grep/find/ls`；新工具（含未来内置、扩展、MCP）默认零检查，护栏覆盖不随工具面增长 | `path-guard.ts:46,113` |
| G4 | **模式兼容性无声明**：一个新工具"能否在哪种模式用、在每种模式下实际在哪执行"没有单一事实源，散落在三套同名覆盖扩展 + quick 钳制 + 文档里；引入者需要自己读完五条路径才能判断 | 全局 |
| G5 | **无人拦截"静默降级到 Host"**：workspace 语义的工具若未实现远端通道，没有任何机制阻止它在远端模式会话里落到服务器本机执行（MCP 现状即此风险的实例） | 全局 |

设计原则（取自 QwenPaw 教训，见参照文档 §7）：

1. **声明即注册**：未声明的工具不存在于护栏世界（fail-closed），而不是"默认放行、
   出事再补名单"；
2. **检测与决策分离**：声明（是什么、在哪执行）→ 装配校验（该模式能不能用）→
   调用拦截（内容检查），三层职责不混；
3. **能力诚实声明**：声明"支持某通道"必须对应已实现的通道代码，未支持就是
   `unsupported`（clamp 掉），绝不静默回退 Host（QwenPaw `_ENFORCED_FIELDS` 思想）；
4. **内置工具的声明存代码**（版本化、可测试、防篡改），MCP/会话动态部分存
   运行时 sidecar（沿用 `.pi/path-policy.scope.json` 模式：运行态、0600、不导出）。

## 2. 核心概念：工具操作层（Tool Operation Layer）

每个工具声明两个正交维度 + 一组安全元数据：

```ts
// pi-config/agent/extensions/amedac-core/src/tool-manifest.ts（纯模块，零 pi 依赖）
type ToolPlane = "host" | "workspace";

interface RemoteSemantics {
  sandbox:       "container-tools" | "bg-channel" | "unsupported";
  "local-machine": "relay-rpc"     | "bg-channel" | "unsupported";
  ssh:           "ssh-exec"        | "bg-channel" | "unsupported";
}

interface ToolManifestEntry {
  name: string;                  // 工具名；MCP 为 "<server>_<tool>" 或服务器级声明
  plane: ToolPlane;              // 操作层（见下）
  risk: "none" | "read" | "write" | "exec" | "network" | "meta";
  pathParams?: string[];         // 路径参数名 → 声明后自动进入路径护栏
  commandParams?: string[];      // 命令参数名 → 声明后自动进入命令护栏
  remote?: RemoteSemantics;      // plane=workspace 时必填
  modes?: SessionMode[];         // 显式模式限制（缺省 = 声明兼容的全部模式）
  origin: "builtin" | "amedac-core" | "pi-web" | "mcp" | "extension";
  notes?: string;                // 引入理由/边界说明（评审用）
}
```

### 2.1 plane：两个操作层

- **`host`**：效果发生在 pi-web 服务器（agent 宿主）上，**不涉及用户工作区内容**
  ——只读写 pi-web 自己的状态（会话 todo、计划文件、后台任务记录），或纯出网
  调用（web search），或交互（问询）。任何会话模式下行为一致。
- **`workspace`**：作用于**工作区内容**（文件读写、命令执行）。执行位置随模式
  变化：host 模式=服务器 cwd；sandbox=容器；ssh/local-machine=远端机器。
  必须声明三条远端通道的语义，未支持的通道=该模式 clamp。

判定标准就是用户需求里的二分：**"不涉及工作区内容、宿主机直接执行"→ host，
可直接引入；否则 → workspace，必须逐模式设计执行方式。**

### 2.2 引入新工具的决策清单

```
新工具
 ├─ 参数里有路径（用户工作区的文件/目录）？          → workspace
 ├─ 会执行命令/脚本（任意 shell/解释器）？           → workspace + commandParams
 ├─ 读写工作区文件内容？                            → workspace + pathParams
 └─ 都不是（纯状态/出网/交互，只碰 pi-web 自有数据）  → host
     └─ host + risk=exec（宿主机上跑任意命令）仍需单独评审（见 §6.4）
```

`host` 工具在五种模式都可用（quick 模式仍受其封闭世界白名单约束）；
`workspace` 工具的可用模式 = `{host}` ∪ 声明了通道语义的远端模式。

新工具的完整引入流程（含不满足现有通道时的改进方案/开发要求模板）见
**附录 A**。

### 2.3 risk 与参数声明驱动护栏（修 G3）

`pathParams` / `commandParams` 是护栏的**挂钩点**：声明之后，现有路径护栏
（`evaluatePathAgainstPolicy` + scope 映射）与命令护栏（`evaluateBashCommand`）
自动适用于该参数，无需在 path-guard 里再加硬编码名单。未声明参数不做内容
检查——这是显式的信任边界，写在声明评审里。

## 3. 模式 × 操作层矩阵

| 模式 | `workspace` 工具执行位置 | `host` 工具执行位置 | 会话 cwd（服务器侧） |
| --- | --- | --- | --- |
| host | 服务器进程（cwd=用户选定目录） | 服务器进程 | 用户选定目录 |
| quick | 无内置编码工具；白名单 MCP direct tools（Host 执行，见 §5） | 服务器进程 | quick 工作区 |
| sandbox | 容器（REST container-tools / bg-channel） | 服务器进程 | 项目 home |
| ssh | 远端机器（ssh exec / SFTP / bg-channel） | 服务器进程 | 项目 home |
| local-machine | 用户机器（relay RPC / bg-channel） | 服务器进程 | 项目 home |

ssh 与 local-machine 在声明层面同属"远端机器"平面，只是通道不同
（`ssh-exec` vs `relay-rpc`）——工具声明时分别勾选。

### 3.1 初始清单（内置与扩展工具）

| 工具 | plane | risk | pathParams | commandParams | remote |
| --- | --- | --- | --- | --- | --- |
| read / write / edit / grep / find / ls | workspace | read/write | path 类参数（按各工具 schema） | — | sandbox=container-tools；lm=relay-rpc；ssh=ssh-exec |
| bash | workspace | exec | — | command | 同上 |
| powershell | workspace | exec | — | command | **三通道 unsupported**（实现事实：三套覆盖只代理 7 个编码工具；远端声明为 unsupported 使缺口不可静默忽略，P1 装配层 clamp） |
| bg_run | workspace | exec | — | command | 三通道=bg-channel（已实现） |
| bg_list / bg_stop | host | meta | — | — | （操纵 host 侧任务记录） |
| todo / plan_save / enter_plan_mode / exit_plan_mode / context_status | host | none/meta | — | — | |
| share_file | host | read | path | — | 读 host 侧快照/活引用；pathParams 使 denyRead（.env/*.key 等）同样阻止分享 |
| Agent / get_subagent_result / steer_subagent | host | meta | — | — | 编排在服务器 |
| rpiv-ask-user-question 等问询工具 | host | none | — | — | |
| MCP `<server>_*` | 按服务器声明（§5） | 按声明 | 按声明 | 按声明 | 当前仅 host 执行 |

> 已知特例（实现时逐个确认，notes 字段记录）：plan-mode 的
> `enter/exit_plan_mode`、子代理桥的保留名。快速会话的 todo/plan 工具当前
> 被 quick 钳制排除——钳制逻辑优先于 manifest 的 modes 缺省值。

## 4. 架构：三层挂载

```
① 引入层（开发时/配置时）——声明与门禁
   代码工具：amedac-core/src/tool-manifest.ts 静态表（版本化，PR 必须同时改表）
   MCP 服务器：mcp.json 条目的 "piWeb" 声明块（§5）
   门禁：注册表完备性测试——所有注册过的工具名必须在 manifest 里（未声明=测试失败）
        │
② 装配层（会话创建/恢复，pi-web 服务器）——模式兼容 clamp
   lib/tool-policy.ts：mode 允许的工具集 = 声明兼容 ∩ 用户选择 ∩ MCP 声明
   workspace 工具在该模式无通道 → 从活动集剔除 + UI 提示，绝不静默 Host 回退
   （泛化 quickToolSet：五模式统一走这一个钳制函数，quick 只是策略最严的一档）
        │
③ 拦截层（每回合 tool_call，amedac-core path-guard 泛化）
   pathParams → evaluatePathAgainstPolicy（现有，含 scope 映射/四选/headless-deny）
   commandParams → evaluateBashCommand（现有）+ 灾难命令分类（新增，§6.3）
   未在会话有效集中的工具调用 → 拒（兜底，正常应已被 ② 剔除）
   动作：allow / deny(reason + 不重试指令) / ask(四选；无 UI = deny)
```

### 4.1 与现有机制的关系（扩展而非重写）

| 现有机制 | 变化 |
| --- | --- |
| path-guard（`PATH_TOOLS` + bash/powershell 硬编码） | 名单改由 manifest 的 `pathParams/commandParams` 驱动；判定逻辑不动 |
| quickToolSet 三层钳制 | 收编为 `lib/tool-policy.ts` 的 quick 档策略；同步逻辑保留 |
| `withExtensionTools` / `applyToolPreferences`（rpc-manager.ts:333/629） | 前置一步模式兼容过滤 |
| bg-channel fail-closed（`missingChannel`） | 保持；bg_run 另获 commandParams 拦截（修 G2） |
| sandbox `disableLocalFallback` | 保持；语义并入声明体系（container-tools 通道缺失=clamp） |
| `.pi/path-policy.scope.json` sidecar | 模式不变；新增 `.pi/tool-policy.json` sidecar 只在需要向拦截层传递会话级声明时写入（MCP 声明快照，§5.2） |

## 5. MCP 接入（修 G1，分两步走）

### 5.0 架构前提：HTTP 优先，stdio 是被约束的例外

工作区模式的架构动机：**客户端装不了环境**，所以扩展在服务端运行、命令经
通道转发到客户端/容器/远端机。这个动机同样决定 MCP 的取舍：

- **HTTP 模式（`type: "http" | "sse"`）是推荐与默认形态**：MCP server 进程
  跑在它自己的部署位置（用户自建服务/第三方 SaaS），pi-web 只从服务器进程
  发出网调用——**不在 pi-web 宿主机上落地任何子进程**，天然不触碰宿主文件
  系统。客户端零安装的目标也同时满足。
- **stdio 模式是例外**：stdio server 必须与发起方同机 spawn，而 MCP 适配器
  在 pi-web 服务器进程内 → stdio server 只能落在**服务器本机**执行
  （`lib/mcp-probe.ts:21-29`）。这正是 G1 的风险本体，也是被本设计约束的
  对象。项目确需 stdio（如只能本地跑的工具）时必须显式声明。

因此默认策略**按传输方式分流**：

| 传输 | 无声明时的默认 | 远端模式（sandbox/ssh/local-machine） |
| --- | --- | --- |
| `http` / `sse` | `plane: host, risk: network`（效果发生在远端服务，不经宿主） | **可用**（维持现状） |
| `stdio` | `plane: host, risk: unknown`（宿主子进程） | **默认剔除**；管理员显式豁免 |

### 5.1 第一步（本设计范围）：声明 + 模式隔离

`mcp.json` 服务器条目增加 pi-web 私有命名空间声明块（pi-mcp-adapter 忽略未知
字段；pi-web 自己的 schema 校验同步扩展）：

```jsonc
{
  "mcpServers": {
    "web-search": {                                  // HTTP：默认全模式可用
      "type": "http", "url": "https://mcp.example/search",
      "piWeb": { "risk": "network" }                 // 声明块可省，省=按传输默认
    },
    "docs-fs": {                                     // HTTP 但带工作区语义：仍需声明
      "type": "http", "url": "https://mcp.example/fs",
      "piWeb": { "plane": "workspace", "pathParams": ["path", "file"] }
      // workspace 而无远端通道 → sandbox/ssh/local-machine clamp
    },
    "local-tool": {                                  // stdio：落宿主执行，默认远端剔除
      "command": "npx", "args": ["-y", "some-mcp"],
      "piWeb": { "plane": "host" }                   // 管理员显式豁免（知情承认）
    }
  }
}
```

**默认规则（fail-closed，修 G5）**：

- `http/sse` 且无 `piWeb`：全模式可用（效果在远端服务，非宿主）；
- `stdio` 且无 `piWeb`：`plane: host, risk: unknown`——
  host / quick 模式维持现状可用（不制造迁移破坏）；
  **sandbox / ssh / local-machine 默认剔除**（stdio 在 Host 执行 = 沙盒逃逸
  面，`agent-framework-review.md` 已列为 P0 风险）；
  管理员可用 `"piWeb": {"plane": "host"}` 显式豁免（知情承认风险，记录在案）；
- 声明 `plane: workspace`（无论传输）：远端模式一律 clamp，直到第二步落地。
  注意 `plane: workspace` 的 HTTP 服务（如远端 fs 服务）在 host 模式同样成立
  ——它操作的是"工作区内容"，只是通道是 HTTP，声明语义不变。

`pathParams` 缺省按参数名约定推断（`path/file/dir/cwd`），可用声明块显式
覆盖/关闭；`commandParams` 只认显式声明（误报代价高）。网关形态（`mcp` 元工具
的嵌套调用）本阶段不解析内容——quick 钳制已排除网关，其余模式网关与 direct
tools 二选一启用时的声明面相同。

### 5.2 第二步（后续设计，不在本期内）：stdio 的远端执行

HTTP 优先策略落地后，本步骤的需求面收窄为"**必须与工作区同机**的 stdio 工具"：

- sandbox：经平台 `tools/bash` 在容器内拉起 stdio server（平台已有 exec 通道）；
- local-machine：relay 增加 `mcp.spawn` RPC（agent 侧进程管理）；
- ssh：ssh exec 拉起 + 端口转发。
落地后，`plane: workspace` 的 stdio 服务器把 `remote.sandbox` 等字段从
`unsupported` 改为对应通道值即可，声明格式不变。纯工具型（搜索/查询类）
不需要此步骤——它们应该走 HTTP。

## 6. 拦截层增强

### 6.1 path-guard 泛化（P0）

- `PATH_TOOLS`/shell 名单 → manifest 驱动；对带 `pathParams` 的 MCP direct tools
  同样生效（声明即受检）；
- 拦截原因文案统一带"不要重复尝试"指令（已有）。

### 6.2 bg_run 收编（P0，修 G2）

manifest：`bg_run → plane: workspace, commandParams: ["command"]`。
路径护栏对 bg_run 的 command 走与 bash 完全相同的
`evaluateBashCommand`（含 cd 追踪/重定向/内联兜底）。

### 6.3 灾难命令分类（P1，借 QwenPaw safety_checks）

在 `path-guard-policy.ts` 增加一个小型**灾难命令分类器**（正则 + resolve 双通道），
覆盖：递归删除根/home/系统树、块设备写入（mkfs/dd of=/dev/）、fork bomb、
`curl|bash` 下载即执行、`rm -rf $HOME` 变量形式。命中即 **deny（不可 ask 豁免）**，
独立于项目策略（类似自保护清单的地位——策略不可放行）。QwenPaw 的对照实现与
真实 bypass 案例清单见参照文档 §2.2。

### 6.4 host+exec 工具的专门约束（P1）

`plane: host, risk: exec`（如未来在服务器上直接跑命令的工具）当前不存在于
默认工具面；manifest 规定此类工具 `modes` 只能显式含 `host`，且引入需在
notes 里写明为什么不能走 workspace 通道。bg_run 在 host 模式下的行为即属此类
（其命令拦截由 §6.2 覆盖）。

## 7. 分阶段落地

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0** | manifest 模块 + 注册表完备性测试；path-guard 名单 manifest 化；bg_run 收编；`灾难命令` 不在此期 | 新测试全绿；现有 path-guard 测试不回归；bg_run 拦截 e2e |
| **P1** | `lib/tool-policy.ts` 模式钳制（五模式统一）；MCP `piWeb` 声明 + 远端模式默认剔除 + 管理员豁免；灾难命令分类器 | 模式矩阵测试；MCP 声明解析测试；VM 实机验证 sandbox 会话无声明 MCP 被剔除 |
| **P2** | 设置页"工具"面板（声明面 + 模式矩阵可视化 + MCP 声明编辑/豁免）；审计日志（onVerdict 扩展记工具维度） | UI 走查；配置包导出不含运行时 sidecar |
| **P3** | MCP 远端执行（§5.2）；`plane: workspace` MCP 通道声明开放 | 平台容器内 stdio e2e |

> **P0 状态（2026-11-05 已落地）**：`amedac-core/src/tool-manifest.ts`（21 条声明：
> 8 内置 + 8 amedac-core + 4 pi-web + 1 扩展 + 幂等校验）；`path-guard.ts` 改为
> `pathParams`/`commandParams` 驱动（不再硬编码工具名单），bg_run 与 bash 共用
> 命令管线，share_file 经 `pathParams` 纳入 denyRead；门禁测试
> `lib/tool-manifest.test.mjs`（7 条：双向完备性/结构校验/四源漂移守卫/模式兼容）。

> **P1 状态（2026-11-05 已落地，VM 实机验收待做）**：
> - **模式钳制**：`lib/tool-policy.ts`（filterToolsForMode / mcpServerModePolicy /
>   filterActiveToolsForMode）；`rpc-manager` 三处接线——初始装配过滤（powershell
>   等声明工具）、`applyToolPreferences` 叠加、远端会话每回合
>   `before_agent_start` 重放（`lib/extensions/mode-tool-clamp.ts`，因 adapter
>   的 syncProxyTool 会把网关加回活动集）；
> - **MCP `piWeb` 声明**：`ServerEntry.piWeb`（plane/risk/pathParams/commandParams）；
>   远端模式默认剔除 stdio/socket 服务器 + 网关元工具 `mcp`/`mcpScript`，HTTP
>   默认放行，`plane:"host"` 显式豁免，`plane:"workspace"` P3 前远端不可用；
> - **灾难命令分类**：`path-guard-policy.ts` 的 `classifyCatastrophicCommand`
>   （结构正则 + 目标段分类双通道；`evaluateBashCommand` 首步硬拒绝，合成
>   target `!catastrophic` 防决策误匹配）；
> - 测试：`lib/tool-policy.test.mjs`(8) + `lib/path-guard-catastrophic.test.mjs`(5)，
>   护栏族回归 116 条全绿。
> - **VM 实机验收（2026-11-05，完整链路通过）**：VM 恢复后 hot-sync 15 个运行时文件 +
>   生产构建/重启成功；安装 pi-mcp-adapter **2.31.0**（`pi install
>   npm:pi-mcp-adapter@2.31.0`，settings.packages 登记，pi 0.85.1 兼容线）。
>   用最小 stdio MCP 桩 + 真实 sandbox 项目验证（`get_tools` RPC 观测）：
>   - 宿主对照会话（cwd=项目 home）：`guardstdio_guard_probe` **ACTIVE**、网关
>     `mcp`/`mcpScript` **ACTIVE**（适配器正常注册）；
>   - sandbox 会话、服务器未声明：同 24 个工具已注册，但 `guardstdio_guard_probe`
>     与网关全部 **inactive**，活动集仅核心 20 个（装配层钳制生效）；
>   - sandbox 会话 + `"piWeb":{"plane":"host"}`：工具与网关恢复 **ACTIVE**（豁免生效）；
>   - `/api/tools/policy` 同步反映 `excludedInMode` true/false。
> - **待做**：会话创建时的剔除提示（P2b）；审计日志（P2c）。

> **P2 状态（2026-11-05 已落地，UI 已视觉验收）**：只读视图
> `GET /api/tools/policy`（工具声明矩阵 + MCP 服务器本模式可见性；判定与装配层
> 共用 lib/tool-policy，禁止两套逻辑）；设置 → 策略页新增「工具护栏」表格
> （工具/操作层/风险/sandbox/local-machine/ssh 六列 + 粘性表头滚动区；MCP
> 服务器/传输/声明/状态/说明五列表格；中英繁体三语文案）。测试
> `lib/tool-policy-clamp.test.mjs`(4) + 路由契约
> `app/api/tools/policy/tool-policy-route.test.mjs`(4)，回归 116 条全绿；
> 本机与 VM 均完成 API 冒烟；本机 UI 截图验收通过（表格化渲染、unsupported
> 红标、MCP 徽标）。**待做**：会话创建时的剔除提示（P2b）；审计日志（P2c）。

## 8. 测试策略

1. **注册表完备性**：`tool-manifest.test.mjs`——从 amedac-core 导出
   `REGISTERED_TOOL_NAMES` 常量，断言 ⊆ manifest；workspace 条目必有完整
   remote 三通道声明；risk 与 pathParams/commandParams 自洽
   （risk=read 不得只有 commandParams 等）；
2. **模式矩阵**：`tool-policy.test.mjs`——每模式 × 每声明形态
   （host/workspace/unsupported/未声明 MCP/管理员豁免）的允许集断言；
3. **拦截泛化**：path-guard harness 增加带声明的自定义工具、MCP direct tool
   名（`<server>_read` 之类）路径拦截用例；
4. **bg_run 回归**：`rm .env` 经 bg_run 被拦（bash 同款用例双跑）；
5. **e2e**：真实 AgentSession 验证 clamp 后的工具对模型不可见、
   deny 文案到达模型；
6. **不回归**：quick 封闭世界既有测试（`quickToolSet` 收编后）原样通过。

## 9. 风险与开放问题

1. **未声明 MCP 在远端模式被剔除是行为变更**：存量用户若在 sandbox 项目里配了
   无声明 MCP 会"消失"。缓解：P1 上线前发布说明 + 会话创建时的 UI 提示 +
   管理员豁免通道；quick 模式不受影响（本就白名单）。
2. **网关形态 `mcp` 元工具的嵌套调用内容不可见**：本阶段以钳制排除网关
   （quick 已如此）+ 声明面覆盖 direct tools 为界；网关内容解析留 P3。
3. **`<server>_` 前缀匹配的歧义**：quickToolSet 已用整段前缀匹配防截断，
   收编时保持同一实现（服务器名可含下划线）。
4. **manifest 与 SDK 升级的漂移**：上游新增内置工具时注册表测试会失败——
   这是期望行为（强制声明），发布流程里把"补 manifest 条目"列入升级清单。
5. **host 工具的越权面**：host 声明不等于免检——`risk: exec/network` 仍需
   评审（§6.4）；后续可加 admin-only 工具激活位（P2 UI 一并考虑）。

## 附录 A：新工具引入规范（开发者指南）

> 本附录回答"要引入一个新工具，需要做什么"。它是引入方与评审方的共同清单，
> 不满足清单的引入视为未完成。

### A.1 第一步：分类（对应 §2.2 决策树）

依次回答四个问题并留痕（写进 manifest 的 `notes`）：

1. 参数里有用户工作区路径吗？
2. 会执行命令/脚本吗？
3. 会读写工作区文件内容吗？
4. 以上都否 → 是否只碰 pi-web 自有状态（会话/任务/计划）或纯出网/交互？

结论：1-3 任一为是 → `plane: workspace`；全否 → `plane: host`。

### A.2 host 工具：直接引入的要求清单

| # | 要求 | 验收 |
| --- | --- | --- |
| H1 | manifest 条目（name/plane/risk/notes） | 注册表完备性测试通过 |
| H2 | `risk: exec` 的 host 工具：notes 必须论证为什么不能走 workspace 通道；`modes` 显式限定 | 评审记录 |
| H3 | 不以工作区路径为参数；确需读宿主文件时列明固定白名单路径 | 评审记录 |
| H4 | 单元测试：工具行为 + 对 path-guard 的 passthrough（无 pathParams/commandParams 时不进内容检查——锁定该信任边界） | 测试绿 |

### A.3 workspace 工具：通道实现要求

`plane: workspace` 必须为三条远端通道逐条给出实现或 `unsupported`：

| 通道 | 复用模式 | 新增实现时的要求 |
| --- | --- | --- |
| sandbox（container-tools） | 参照 `amedac-core/src/sandbox/operations.ts`：平台 REST 端点 + 路径映射（`toContainerPath`） | 平台侧新增端点须走 `sandbox-platform` 评审；路径必须经 pathMapper |
| local-machine（relay-rpc） | 参照 `lib/extensions/relay-tools.ts`：`relayRpc` + 方法名 | agent（Go）侧需实现对应 RPC 方法；**必须加版本门禁**（`requireCompatibleAgent`，agent 未升级时 fail-closed 报"请升级 Agent Client"，绝不回退宿主执行） |
| ssh（ssh-exec / SFTP） | 参照 `lib/extensions/ssh-tools.ts`：项目级连接池 + `remotePath` 锚定 | 注意 Windows 目标机的路径分隔符 |
| bg-channel（三模式通用） | 参照 `amedac-core/src/bg-shell.ts` + `lib/extensions/bg-channels.ts` | 仅适用于"跑长命令"语义的工具；沿用 `missingChannel` fail-closed |

通用要求：

| # | 要求 | 验收 |
| --- | --- | --- |
| W1 | 同名覆盖注册（同 SDK 工具名，`pi.registerTool`），**禁止静默回退宿主执行**：通道缺失时报错（参照 `disableLocalFallback` / `missingChannel` 模式） | e2e：断开通道时工具调用得到明确错误而非本地执行 |
| W2 | `pathParams`/`commandParams` 声明齐全，路径护栏与命令护栏自动生效 | 拦截测试（harness 层）绿 |
| W3 | 恢复路径同步注入（`lib/session-restore-options.ts`——漏注入会让远端会话退化为本地会话，历史教训） | 恢复会话 e2e |
| W4 | 每条 `unsupported` 通道在 clamp 时对用户可见（会话创建提示），不是无声消失 | UI/日志断言 |
| W5 | 模式矩阵测试：五模式 × 该工具的允许/剔除断言 | `tool-policy.test.mjs` 用例 |

### A.4 现有通道都不满足时：改进方案（开发要求说明）模板

需要扩展通道能力（例如 relay 缺一个新 RPC、平台缺一个新端点）时，引入方必须
随 PR 附一份**通道扩展需求说明**，包含：

1. **工具语义**：做什么、输入输出、为什么必须与工作区同机（而不是 host 工具
   或 HTTP 服务）；
2. **通道缺口**：现有三条通道各自缺什么（逐条说明，不允许只写"都不支持"）；
3. **扩展设计**：新 RPC 方法/端点签名、agent 侧（Go）或平台侧改动、版本门禁
   与兼容性策略（旧 agent 的降级行为=fail-closed 报错）、超时与错误码约定；
4. **HTTP 替代评估**：论证为什么不能做成 HTTP MCP 服务（§5.0 的默认答案优先）；
5. **安全评审点**：新通道面上的路径映射、凭据传递、资源清理；
6. **回滚方案**。

评审顺序：先质疑 plane 分类（能不能是 host / HTTP）→ 再质疑通道复用 →
最后才允许新通道。新增通道是最后手段，因为它把"服务端运行扩展、客户端转发
命令"的架构复杂度转嫁给了所有客户端实现（Go agent、平台、ssh 桥三处）。

### A.5 MCP 工具的引入（面向配置者而非开发者）

- 优先 HTTP：给出服务 URL 即可，默认全模式可用，无需声明；
- stdio：默认只在 host/quick 会话可用；要在远端模式用，管理员加
  `"piWeb": {"plane": "host"}` 豁免（UI 呈现风险提示）；
- 带工作区语义（参数收路径）的服务：无论传输，都要 `piWeb.pathParams` 声明，
  使路径护栏生效；远端模式在 P3 前不可用。
