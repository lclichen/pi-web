---
name: mcp-server-integration
description: 为 pi-web Agent 编写/接入 MCP 服务器：传输与 piWeb 执行面声明、local-machine 配对机器执行、mcp.json 结构、adapter 参数、超时/生命周期，以及 pi-web 注入的会话与用户标识。
---

# MCP 服务器编写与接入

本技能解决两个问题：

1. **接入一个已有 MCP 服务器**（HTTP 或 stdio）；
2. **自己写一个 MCP 服务器**（例如 `node .pi/mcp/cli.js`），并决定它到底在
   哪台机器上执行。

pi-web 的 MCP 客户端是 pi-mcp-adapter；配置写在项目的 `.pi/mcp.json`。
但适配器自己只在 **pi-web 服务器进程**里 spawn stdio 子进程。因此
“在用户自己的电脑/本地模式工作区里运行”需要 `piWeb.plane="workspace"`
声明，由 relay MCP host 在用户配对机器上承载。

## 1. 先选执行面（最重要）

| 场景 | 配置 | 实际执行位置 | 普通用户可用？ |
|---|---|---|---|
| 远程/共享 HTTP MCP | `url`，不写 `piWeb` | pi-web 服务器发起 HTTP 请求 | 是 |
| 本地模式项目里自己写的 stdio MCP | `command` + `"piWeb": {"plane":"workspace"}` | 用户配对机器，项目工作区 | 是（project scope） |
| 管理员维护的宿主 stdio MCP | `command` + `"piWeb": {"plane":"host"}` | pi-web 服务器进程 | 否（管理员） |
| Host/CLI 项目、单机 pi-web | `command`（可省略 plane） | pi-web 所在机器 | 管理员/单机 |
| sandbox / SSH 的 stdio MCP | `command` + `plane:"workspace"` | 尚无远端执行通道 | 否（暂不支持） |

规则：

- **能用 HTTP 就用 HTTP**：它是跨模式最稳的方案，不依赖配对机器在线。
- `plane:"workspace"` 当前只支持 **local-machine 项目 + stdio**。
- `plane:"workspace"` 的 HTTP 条目仍会被远端模式剔除；需要 HTTP 时不要写
  `plane`，直接给 `url`。
- `plane:"host"` 只给管理员/可信配置使用，它会在控制面执行代码。
- 普通用户不能创建 user scope 的 stdio MCP（用户配置没有机器绑定）；
  本地模式的自定义 MCP 请放在 **project scope**。

## 2. 三种推荐配置

### A. 本地模式：自己写的 Node stdio MCP

```json
{
  "mcpServers": {
    "my-local-tools": {
      "command": "node",
      "args": [".pi/mcp/cli.js"],
      "env": { "MY_MCP_MODE": "workspace" },
      "requestTimeoutMs": 120000,
      "includeTools": ["read_note", "write_note"],
      "piWeb": { "plane": "workspace", "risk": "write" }
    }
  }
}
```

行为：

- 进程由 **Go agent** 在用户配对机器上启动；
- `cwd` 默认是项目工作区（可用 `cwd` 指定工作区内目录）；
- 工具由 pi-web 在会话启动时通过 `mcp.listTools` 列出，注册为
  `mcp_<server>_<tool>`（例如 `mcp_my_local_tools_read_note`）；
- 工具调用通过 `mcp.callTool` 走 relay，`_meta` 带 `amedac/session_id`、
  `amedac/user_id`、`amedac/user_name`；
- 会话结束发送 `mcp.close`，进程退出；`requestTimeoutMs` 是该工具的调用超时。

要求 **Agent ≥ 0.8.0**（feature `mcp-relay-v1`）。旧 Agent 不会注册这些
工具，也不会在服务器上偷偷启动它们。

### B. 远程 HTTP MCP（推荐给普通用户）

```json
{
  "mcpServers": {
    "internal-api": {
      "url": "https://mcp.example.internal/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "auth": "bearer",
      "directTools": true,
      "requestTimeoutMs": 1800000
    }
  }
}
```

- 请求从 pi-web 服务器发出，所有模式默认可用；
- 服务端要能从 **pi-web 服务器**访问到该 URL；
- 普通用户没有公网入口时，用 VPN/Tailscale 或 SSH 反向隧道：
  `ssh -N -R 127.0.0.1:7333:127.0.0.1:7333 user@pi-web-server`，再配置
  `http://127.0.0.1:7333/mcp`；
- 必须自己加鉴权；不要暴露无鉴权的本地端口。

### C. 管理员宿主 stdio

```json
{
  "mcpServers": {
    "host-tool": {
      "command": "npx",
      "args": ["-y", "some-trusted-mcp"],
      "piWeb": { "plane": "host", "risk": "exec" }
    }
  }
}
```

只用于可信服务器；普通用户创建会被 `403`。远程模式下 `plane:"host"` 是
显式豁免，仍意味着代码在 pi-web 服务器执行。

## 3. `piWeb` 声明完整说明

`piWeb` 是 pi-web 私有命名空间，pi-mcp-adapter 会忽略它。

```json
{
  "piWeb": {
    "plane": "workspace",
    "risk": "write",
    "pathParams": ["path", "file"],
    "commandParams": ["command"]
  }
}
```

| 字段 | 取值 | 作用 |
|---|---|---|
| `plane` | `host` / `workspace` | 执行面。`host`=服务器；`workspace`=local-machine 配对机器（stdio） |
| `risk` | `none` / `read` / `write` / `exec` / `network` / `unknown` | 风险声明；当前用于展示/后续审批，不替代 MCP 自身鉴权 |
| `pathParams` | 字符串数组 | 声明该 MCP 工具的路径参数；当前为后续 path-guard 接入预留，**尚未自动拦截 MCP 内部文件操作** |
| `commandParams` | 字符串数组 | 声明命令参数；同上，当前为预留 |

`plane` 的模式矩阵：

| 会话/项目模式 | 默认 stdio | `plane:"host"` | `plane:"workspace"` stdio |
|---|---|---|---|
| Host / 单机 | 服务器执行 | 服务器执行 | 仍由适配器在服务器执行；Host 请用 `host` 或省略 |
| Quick | 服务器执行 | 服务器执行 | 仍由适配器在服务器执行 |
| local-machine | 默认剔除 | 服务器执行（管理员豁免） | **配对机器执行（relay MCP host）** |
| sandbox | 默认剔除 | 服务器执行（管理员豁免） | 暂不支持（被剔除） |
| SSH | 默认剔除 | 服务器执行（管理员豁免） | 暂不支持（被剔除） |

## 4. 写一个 Node stdio MCP：最小可运行形态

MCP stdio 使用 **按行分隔的 JSON-RPC 2.0**。下面是一个零依赖示例，适合
直接放进 `.pi/mcp/cli.js`（不依赖 `node_modules`）：

```js
#!/usr/bin/env node
// 零依赖 MCP stdio server：只实现 initialize / tools/list / tools/call。
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "my-local-tools", version: "1.0.0" },
      },
    });
  }
  if (req.method === "notifications/initialized") return;
  if (req.method === "tools/list") {
    return send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [{
          name: "echo",
          description: "Echo text back",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        }],
      },
    });
  }
  if (req.method === "tools/call") {
    if (req.params?.name !== "echo") {
      return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unknown tool" } });
    }
    return send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [{ type: "text", text: `echo:${req.params?.arguments?.text ?? ""}` }],
      },
    });
  }
});
```

说明：

- 相对路径以项目工作区为 cwd；写文件时自己把路径限制在工作区内。
- 需要依赖时，把依赖随 `.pi/mcp/node_modules` 一起交付，或先在工作区
  安装；不要假设用户机器上有全局包。
- `initialize` 返回的协议版本可以协商；服务端应兼容
  `2025-06-18` / 旧版本。
- 目前 relay host 会忽略 MCP 的 progress/logging 通知，也不支持
  sampling/elicitation（服务端反向请求会收到 method-not-found）。
- 工具元数据是 **会话启动时快照**；修改 `cli.js` 或工具列表后新建会话。

如果你使用官方 SDK，依赖与入口同样要放在 `.pi/mcp` 内，并确认包里有
`@modelcontextprotocol/sdk`；零依赖版本更适合分发给普通用户。

## 5. 超时与生命周期

优先级从高到低：

1. 单服务器 `requestTimeoutMs`
2. 全局 `settings.requestTimeoutMs`
3. MCP SDK 默认 **60000ms**

旧字段 `toolTimeoutMs` 已被 adapter 2.31 忽略；pi-web 会话启动会自动迁移。

其他参数：

- `lifecycle`：适配器连接时机；relay host 当前是“会话启动时 list、会话结束
  关闭”，不单独实现 lazy/eager。
- `idleTimeout`：**分钟**；relay host 暂不按空闲断开，仍以会话生命周期为准。
- `directTools`：适配器参数；relay host 会把列出的工具全部直接注册，不受该
  字段影响。
- `includeTools` / `excludeTools`：relay host 也生效，按原始 MCP 工具名过滤。
- `env`：relay host 只传 PATH/HOME 等基础环境 + 这里声明的变量；不会把
  pi-web 的 `PI_*`/relay token 透传给 MCP 进程。

## 6. pi-web 自动注入的身份

HTTP/SSE MCP 每次请求由适配器附加：

| Header | 值 |
|---|---|
| `x-session-id` | 当前 pi-web 会话 id |
| `x-amedac-session-id` | 同上（兼容别名） |
| `x-amedac-user-id` | 会话属主用户 id |
| `x-amedac-user-name` | 用户名，URI 编码 |
| `_meta` | `amedac/session_id`、`amedac/user_id`、`amedac/user_name` |

stdio（包括 local-machine relay host）没有 HTTP header，但 `tools/call`
的 `_meta` 带同样的三项标识。`x-amedac-user-name` 需要
`decodeURIComponent`；服务端不要把标识本身当授权凭据，仍要校验自己的
token/ACL。

## 7. 安全与信任

- `plane:"workspace"` 会在 **用户自己的机器** 上执行项目里的代码；只对
  自己信任的项目启用。共享/导入的项目要逐条确认 MCP 配置。
- 普通用户创建 project stdio MCP 时，只有 `plane:"workspace"` +
  local-machine 项目会被允许；其它情况需要管理员。
- 设置页的“测试连接”不会在服务器上启动 workspace stdio；请在本机模式
  会话中验证。
- MCP 工具目前不经过 path-guard；服务端自己负责路径边界和鉴权。
- 不要把密钥写进 `.pi/mcp.json`；用环境变量或运行环境注入。

## 8. 自检清单

1. `.pi/mcp.json` 是合法 JSON；每个 server 有 `command` 或 `url`。
2. 要跑在用户机器上：project scope + `command` + `piWeb.plane="workspace"`
   + local-machine 项目 + Agent ≥ 0.8.0。
3. 远程 HTTP：不写 `plane`，URL 从 pi-web 服务器可访问，带鉴权。
4. 普通用户不要创建 user scope stdio；Host/宿主 stdio 只用 `plane:"host"`。
5. 长任务写 `requestTimeoutMs`（毫秒），不要用 `toolTimeoutMs`。
6. `args` 是字符串数组，`env`/`headers` 是字符串 map。
7. 修改 MCP 工具后新建会话（工具列表是启动快照）。
8. 调试顺序：配置 JSON → Agent 版本/在线 → 会话里工具是否存在 →
   `_meta`/超时/进程退出原因。
