---
name: mcp-server-integration
description: 为 pi-web Agent 定义接入 MCP 服务器：mcp.json 结构、pi-mcp-adapter 客户端参数、超时/生命周期、以及 pi-web 注入的会话与用户标识（HTTP headers + MCP _meta）。
---

# MCP 服务器接入与 pi-web 标识

本技能面向“给 Agent 定义一个可用的 MCP 工具面”，覆盖服务器配置、adapter 参数和 pi-web 的会话身份传递。Agent 运行时由 pi-mcp-adapter 负责 MCP 客户端，配置写在项目的 `.pi/mcp.json`。

## 1. 先选传输方式

| 场景 | 推荐 | 原因 |
|---|---|---|
| 远程 MCP（HTTP/SSE） | `url` | 请求由 pi-web 发起，不落到会话执行环境；远程模式下默认可用 |
| 本机 stdio MCP | `command` | 进程在 **pi-web 服务器**启动，属于控制面执行；普通用户项目默认被远端模式剔除 |
| 需要 host 上运行的 stdio | `command` + `"piWeb": {"plane": "host"}` | 仅管理员显式豁免，知情承担沙盒逃逸面风险 |

沙盒/本机/SSH 会话里，stdio/socket MCP 默认不出现在工具面。能用 HTTP 就不要用 stdio。

## 2. `.pi/mcp.json` 最小结构

```json
{
  "mcpServers": {
    "internal-api": {
      "url": "https://mcp.example.internal/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      },
      "auth": "bearer",
      "directTools": true,
      "lifecycle": "lazy",
      "requestTimeoutMs": 1800000
    },
    "local-helper": {
      "command": "node",
      "args": [".pi/mcp/helper.mjs"],
      "env": { "HELPER_HOME": ".pi/mcp" },
      "directTools": ["search", "fetch"],
      "lifecycle": "keep-alive",
      "idleTimeout": 30
    }
  },
  "settings": {
    "requestTimeoutMs": 120000,
    "idleTimeout": 10
  }
}
```

规则：

- 每个服务器必须有 `command`（stdio）或 `url`（http）之一；`args` 是字符串数组，`env`/`headers` 是字符串 map。
- `headers` 里的 `${VAR}` / `$env:VAR` 会在连接时用环境变量插值；值以 `!` 开头会执行命令取密钥（`!!` 表示字面量 `!`）。
- `disabled: true` 的服务器保留配置但不连接。
- `piWeb.plane` 是 pi-web 私有声明：`host` 允许远端模式下的 stdio，`workspace` 表示要操作工作区（当前远端通道未支持，会被剔除）。

## 3. 超时与生命周期（最容易配错）

优先级从高到低：

1. 单服务器 `requestTimeoutMs`
2. 全局 `settings.requestTimeoutMs`
3. MCP SDK 默认 **60000ms**

所以“每个调用大约一分钟就断”通常不是 adapter 的 bug，而是把超时写成了旧字段 `toolTimeoutMs`（adapter 2.31 已忽略）。长任务请写：

```json
{ "requestTimeoutMs": 1800000 }
```

其他参数：

- `idleTimeout`：**分钟**，不是毫秒。单服务器覆盖全局；`0` 禁用空闲断开。
- `lifecycle`：`lazy`（首次调用连接）、`keep-alive`（保持连接）、`lazy-keep-alive`、`eager`。
- `directTools`：`true` 暴露全部工具，字符串数组只暴露白名单；否则经 `mcp` 网关调用。
- `includeTools` / `excludeTools`：工具名白/黑名单。
- `requestHeadersCommand`：每个 HTTP 请求前运行受信任命令生成 header；它只收到 `{method,url,bodyBase64}`，**拿不到 pi-web session/user**，不要用它传身份。

## 4. pi-web 自动注入的身份

pi-web 通过 pi-mcp-adapter 在每次 HTTP/SSE MCP 请求上自动附加以下标识；stdio 没有 HTTP header，但仍带 `_meta`。

### HTTP headers

| Header | 值 |
|---|---|
| `x-session-id` | 当前 pi-web 会话 id |
| `x-amedac-session-id` | 同上（兼容别名） |
| `x-amedac-user-id` | 会话属主的用户 id |
| `x-amedac-user-name` | 用户名，URI 编码（`encodeURIComponent`） |

### MCP `_meta`

每个 `tools/call` 请求携带：

```json
{
  "amedac/session_id": "…",
  "amedac/user_id": 7,
  "amedac/user_name": "alice"
}
```

说明：

- 两套标识同时存在：header 便于网关/反向代理做路由与审计，`_meta` 便于 MCP 服务端在工具调用里直接读取。
- header 只对 HTTP/SSE 生效；stdio 服务器请读 `_meta`。
- `x-amedac-user-name` 是 URI 编码的，服务端要 `decodeURIComponent`；`_meta` 里是原始 UTF-8。
- 服务端不要把 header/`_meta` 当作授权凭据本身，仍应校验自己的 token/ACL。
- 不要在 `.pi/mcp.json` 的 `headers` 里伪造这几个名字；adapter 会用动态身份覆盖静态值。

服务端读取示例（Node HTTP）：

```js
const sessionId = req.headers["x-amedac-session-id"];
const userId = req.headers["x-amedac-user-id"];
const userName = decodeURIComponent(String(req.headers["x-amedac-user-name"] ?? ""));
```

MCP 工具里读取 `_meta`（不同 SDK 字段名可能不同）：

```js
const meta = extra?._meta ?? {};
const sessionId = meta["amedac/session_id"];
const userId = meta["amedac/user_id"];
```

## 5. 2.38 兼容要点（Pi 0.85–0.87 旧路径）

- 在 Pi 0.85–0.87 上，`mcp.json` 仍是 adapter 自己的配置；Pi 0.99+ 的内置 MCP 配置接管不会发生。
- 2.38 新增的可选字段：`protocolVersion: "legacy" | "auto" | "2026-07-28"`、`tasks`、`inheritEnv`、`caFile`、`clientMetadataUrl`、`directTools: "search"`；不设置时行为与旧版一致。
- `protocolVersion: "auto"` 且服务端支持 MCP Tasks 时，长调用会变成可轮询任务；可用 `tasks: false` 关闭。
- 2.35 起，自命名（self-namespaced）工具不再重复加前缀，工具名可能变化；升级后检查提示词、白名单和快捷会话模板里的精确工具名。
- 2.33 起，`directTools: "search"` 的工具要等搜索/网关首次调用后才激活；依赖“开箱即用”的工具面时不要用 search 模式。
- 2.33 起，审批 broker 会观察缓存调用，session 授权只在 broker abstain 时生效；自定义权限扩展需要复核语义。
- 2.34 起，重模块按需加载；不要依赖 adapter 模块的加载顺序或顶层副作用。

## 6. 自检清单

1. `.pi/mcp.json` 是合法 JSON；每个 server 有 `command` 或 `url`。
2. 长任务使用 `requestTimeoutMs`（毫秒），不是 `toolTimeoutMs`。
3. `idleTimeout` 用分钟；不确定就留空走全局/默认。
4. 远程模式优先 HTTP；stdio 需要 `piWeb.plane="host"` 且仅管理员使用。
5. 服务端能读取并校验 `x-amedac-user-id` / `amedac/user_id`；用户名做 URI 解码。
6. 调试：设置页「测试连接」只看连接；工具调用超时看 `requestTimeoutMs`，进程被杀看 `idleTimeout`/容器。
7. 修改后新会话或刷新会话使 adapter 重新加载配置。
