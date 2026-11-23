# MCP 总览

> 状态：现行（2026-11-23）。本文件是 MCP 的框架入口；细节见
> [mcp-scopes-and-overrides.md](./mcp-scopes-and-overrides.md)、
> [mcp-file-sharing.md](./mcp-file-sharing.md)、[mcp-inline-images.md](./mcp-inline-images.md)。

## 1. 作用域与优先级

| scope | 文件 | 优先级 | 谁能改 |
|---|---|---|---|
| project | `<projectHome>/.pi/mcp.json` | 最高 | 项目属主（受信任/写锁） |
| quick | `<dataDir>/mcp-quick.json` | 中 | 管理员 |
| user | `<dataDir>/state/users/u<id>/pi/mcp.json` | 中 | 用户自己 |
| global | `<agentDir>/mcp.json`、`~/.agents/mcp.json` | 最低 | 管理员 |

项目同名条目覆盖低层；项目可用 `{disabled:true}` 墓碑临时关闭全局/快速服务器。

Quick 会话的工具面由管理员模板决定（设置 → 快速会话模板）：

- `mcpServers`：整服务器授权（该服务器全部 `<server>_<tool>`）；
- `mcpTools`：工具级授权，精确 `<server>_<tool>`，与子智能体
  `ext:pi-mcp-adapter/<server>_<tool>` 同一标识；
- 两者并集；都为空 = 没有 MCP 工具（封闭世界，不是"全部允许"）。

工作区 `.pi/mcp.json` 会启用被引用服务器并遮蔽其它服务器；最终活动工具集每回合由
`quickToolSet` 按上述两个维度精确过滤（适配器没有按工具过滤的配置字段）。

## 2. 传输与执行面

| 配置 | 执行位置 | 普通用户 |
|---|---|---|
| `url`（HTTP/SSE） | pi-web 服务器发起请求 | ✅ |
| `command`（stdio，默认） | pi-web 服务器进程 | ❌（控制面执行） |
| `command` + `plane:"host"` | pi-web 服务器（显式豁免） | 仅管理员 |
| `command` + `plane:"workspace"` + local-machine 项目 | 用户配对机器（Agent 0.8+） | ✅（project scope） |
| sandbox/SSH 的 workspace stdio | 尚无远端通道 | ❌ |

规则：

- 远程模式（sandbox/ssh/local-machine）默认剔除未声明的 stdio，避免控制面执行。
- local-machine 的 workspace stdio 必须：
  - project scope；
  - `lifecycle: "lazy"` 或 `lazy-keep-alive`；
  - `directTools: false`。
  
  否则 adapter 会在会话启动时连接/拉取元数据，可能落到服务器。
- HTTP MCP 不需要 `plane`；服务端要能从 pi-web 服务器访问 URL，并自行鉴权。

## 3. Relay MCP host（local-machine）

配置示例：

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": [".pi/mcp/cli.js"],
      "lifecycle": "lazy",
      "directTools": false,
      "requestTimeoutMs": 120000,
      "piWeb": { "plane": "workspace", "risk": "write" }
    }
  }
}
```

行为：

- Agent 启动/复用 stdio 进程，执行 initialize + tools/list；
- pi-web 注册工具为 `mcp_<server>_<tool>`；
- 调用走 `mcp.callTool`，`_meta` 带 `amedac/session_id|user_id|user_name`；
- 会话结束 `mcp.close`；
- 文本/图片内容映射回工具结果；工具列表是启动快照；
- Agent 0.8.0 feature `mcp-relay-v1`；旧 Agent 不注册这些工具，不会回落服务器。
- 创建/更新/导入/同步/会话启动均校验安全字段；MCP 设置页选择 workspace 会自动写
  `lazy` + `directTools:false`。

限制：stdio only，project scope only，local-machine only；sandbox/SSH 尚未支持；
MCP 内部路径操作未自动接 path-guard；采样/elicitation/进度通知未支持。

## 4. 身份注入

HTTP/SSE：

| Header | 值 |
|---|---|
| `x-session-id` | 当前会话 id |
| `x-amedac-session-id` | 同上 |
| `x-amedac-user-id` | 用户 id |
| `x-amedac-user-name` | 用户名（URI 编码） |
| `_meta` | `amedac/session_id`、`user_id`、`user_name` |

stdio（含 relay host）没有 HTTP header，但 tools/call 的 `_meta` 相同。它们不是授权
凭据；服务端仍需校验自己的 token/ACL。

## 5. 超时与生命周期

优先级：

1. 单服务器 `requestTimeoutMs`
2. 全局 `settings.requestTimeoutMs`
3. MCP SDK 默认 60000ms

- `toolTimeoutMs` 已弃用，会话启动自动迁移。
- `idleTimeout` 分钟；relay host 目前按会话生命周期关闭，不单独按 idle 断开。
- `lifecycle`：adapter 的连接时机；relay host 要求 lazy/lazy-keep-alive。
- `includeTools`/`excludeTools`：relay host 也生效。
- `directTools`：adapter 参数；relay host 会直接注册全部列出的工具，但配置必须显式
  false 以阻止 adapter 启动连接。

## 6. 相关功能

- **配置包/Agent Builder**：`.pi/mcp.json` 随项目配置包分发；导出/导入有 schema、
  凭证、stdio 闸门。
- **文件分享**：MCP 工具 `share_file` 生成一次性下载链接；Host 活引用/远程快照。
- **内联图片**：MCP ImageContent → `[[image:img_...]]`，资产库 + 聊天原位渲染。
- **工具护栏**：MCP 服务器可声明 `piWeb.risk/pathParams/commandParams`；当前声明为
  预留，不自动拦截 MCP 内部路径。
- **管理 UI**：设置 → MCP；普通用户可创建 HTTP / local-machine workspace stdio；
  全局/快速 scope 仅管理员。

## 7. 自检清单

1. HTTP MCP：URL 从 pi-web 服务器可达，带鉴权；
2. local-machine stdio：project scope + plane workspace + lazy + directTools false +
   Agent ≥0.8；
3. 不要在 user scope 建 stdio（没有机器绑定）；
4. 长任务用 `requestTimeoutMs`；
5. 改 MCP 工具后新建会话（列表快照）；
6. 失败排查：配置 JSON → 项目信任 → Agent 在线/版本 → 会话工具 → 进程 stderr/超时。
