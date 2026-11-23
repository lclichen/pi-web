# agent-client

用户机器上的 Go 静态 relay 客户端。通过 WebSocket 外连 pi-web，提供文件、搜索、命令、
PTY 和 MCP host 能力。当前版本 **0.8.0**。

**框架文档（权威）：[`docs/dev/CONNECT_LOCAL_MACHINE.md`](../docs/dev/CONNECT_LOCAL_MACHINE.md)**。
本文只保留目录内快速上手和构建信息。

## 快速使用

```bash
# 配对（一次性码 5 分钟）
agent-client pair --code <CODE> --server http://<pi-web-host>:30142

# 运行（TTY 下交互菜单；服务下使用保存的连接）
agent-client run [--server URL] [--root PATH] [--replace]

agent-client version
```

配置：`~/.agent-client/config.json`（0600；旧 `~/.pi-agent` 兼容）。支持多服务端
profiles、`--replace` 替换同 machineId 的旧连接。

## 构建

```bash
cd agent
export GOPROXY=https://goproxy.cn,direct
./scripts/build.sh
```

产物 `dist/agent-client-{linux,darwin}-{amd64,arm64}` + `windows-amd64.exe`；
CGO 关闭，Linux 静态链接，可在 CentOS 7（glibc 2.17）运行。

## 能力

| 类别 | 方法 |
|---|---|
| fs | `fs.list` `fs.manifest` `fs.read` `fs.write` `fs.stat` `fs.mkdir` `fs.delete` `fs.rename` |
| search | `search.grep` `search.fd` |
| exec | `exec.run` `exec.stream` |
| pty | `pty.create` `pty.input` `pty.resize` `pty.close` |
| mcp | `mcp.listTools` `mcp.callTool` `mcp.close`（0.8.0） |

features：`workspace-base`、`binary-read`、`binary-write`、`projection-v1`、`mcp-relay-v1`。

## 安全

- workspace root + 每请求 `base`；拒绝 `..`/symlink 逃逸。
- `exec.run` 只接受 argv，无 shell 注入面。
- MCP host 使用环境变量白名单，不透传 `PI_*`/relay token。
- 配对码单次、5 分钟；token 0600；WS 建连校验。
- 用户机器 OS 权限是最终边界。

## GUI

`agent/gui/` 是 MyGo 桌面客户端 `agent-client-gui`，构建/主题/打包说明见
[`agent/gui/README.md`](./gui/README.md)。

完整协议、多机器、MCP host、部署与故障排查见
[`docs/dev/CONNECT_LOCAL_MACHINE.md`](../docs/dev/CONNECT_LOCAL_MACHINE.md)。
