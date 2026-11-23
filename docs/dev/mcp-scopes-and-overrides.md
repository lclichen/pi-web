# MCP 作用域与工作区级启停

> 状态：现行（2026-11-23）。总览见 [mcp.md](./mcp.md)。

## 四个 scope

| scope | 文件 | 优先级 | 谁能改 |
|---|---|---|---|
| project | `<projectHome>/.pi/mcp.json` | 最高 | 项目属主（受信任/写锁） |
| quick | `<dataDir>/mcp-quick.json` | 中 | 管理员 |
| user | `<dataDir>/state/users/u<id>/pi/mcp.json` | 中 | 用户自己 |
| global | `<agentDir>/mcp.json`（及 `~/.agents/mcp.json` 发现路径） | 最低 | 管理员 |

同名服务器按上表优先级去重；高优先级条目遮蔽低优先级条目
（pi-mcp-adapter 链）。

## local-machine 的 relay MCP host

project scope 的 stdio 条目如果声明 `"piWeb": {"plane": "workspace"}`，且项目
是 local-machine 模式，pi-web 不会让 adapter 在服务器上 spawn 它，而是由
`lib/extensions/remote-mcp.ts` 在会话启动时通过 Go agent（≥ 0.8.0，
`mcp-relay-v1`）在用户配对机器上启动。工具名是 `mcp_<server>_<tool>`，
调用走 `mcp.callTool`，`_meta` 带 `amedac/*` 身份；会话结束发 `mcp.close`。
普通用户创建/导入/同步这类条目时，控制面闸门只在上述组合下放行。用户
scope 没有机器绑定，仍不允许 stdio。HTTP 服务器不需要 `plane`，继续按
普通 MCP HTTP 配置使用。

该条目必须同时写 `lifecycle: "lazy"`（或 `lazy-keep-alive`）与
`directTools: false`；否则 adapter 会在启动时为 keep-alive/eager/direct-tools
元数据连接它，可能在 pi-web 控制面执行。创建/更新、配置包导入、工作区同步、
会话启动都会校验；设置页选择 workspace 保存时自动写入安全值。

## 工作区级禁用 = 墓碑覆盖

全局/快速服务器要在**当前项目**单独关闭时，不修改原始配置，而是在
`<cwd>/.pi/mcp.json` 写一条只有 `disabled` 的墓碑：

```json
{ "mcpServers": { "memory": { "disabled": true } } }
```

适配器把该条目视作“不存在”，所以本项目的会话看不到这个服务器，其他项目
不受影响。重新启用时删除墓碑；如果项目里本来就有同名条目，则直接改它的
`disabled` 标记。

`readMcpConfig()` 会把这个墓碑**合并回**底层真实条目再返回（`scope` 保持
global/quick，`disabled: true`，`projectOverride: true`），避免设置页把
“只有 disabled 的空配置”当成服务器本体展示。

## PATCH 语义

`PATCH /api/mcp/servers/<name>`

```json
{ "cwd": "...", "scope": "global", "disabled": true, "target": "project" }
```

- `target: "project"`（默认）：写工作区墓碑/项目条目。普通用户可用，
  即使 `scope=global/quick` 也不要求管理员——因为它只影响当前项目。
- `target: "scope"`：直接改该条目在自身配置文件里的 `disabled`。全局/快速
  配置仅管理员可用（`guardMcpRequest` 拦截）。
- 启用（`disabled:false`）时，如果移除墓碑后底层条目本身仍是 disabled，
  返回 409 并提示“需管理员在对应配置中启用”。

## UI 行为

- 设置页详情开关、分组开关、工具栏 MCP 弹层：都是 `target=project`，
  文案为“在当前工作区启用/禁用”。
- 管理员选中 global/quick 条目时，表单里额外出现“在全局配置中禁用/在快速
  会话配置中禁用”复选框；勾选后点“保存”才写入原始配置（PUT），与工作区
  开关分离。
- 普通用户不能保存/删除 global/quick 条目（按钮禁用并提示），也不能在
  新建时选择 global/quick scope；但可以在当前项目覆盖启停。
