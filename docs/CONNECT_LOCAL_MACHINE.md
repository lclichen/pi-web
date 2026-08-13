# 连接本地机器（Connect Local Machine）

让 pi-web 在浏览器里直接操作用户本地机器（如 **CentOS 7**）的文件系统与命令行：
读/写/列目录/搜索/执行命令，并能跑交互式终端（Phase 2）。

采用 **本地 Agent + 服务端 Relay** 架构（类 VS Code Remote Tunnel）。Agent 是一个
**Go 静态二进制**，零运行时依赖，`chmod +x` 即可在 CentOS 7（glibc 2.17）上运行。

## 架构

```
┌───────────┐  HTTP+SSE (30141)  ┌─────────────────────────────┐  WS (30142)   ┌──────────────┐
│  浏览器    │ ─────────────────► │ pi-web 服务端 (Node/Next)    │ ◄───────────► │ Local Agent  │
│ (任意浏览器)│ ◄───────────────── │ /api/agent-relay/**  │ Relay │ :30142        │ (Go 静态二进制)│
└───────────┘ pair/status/rpc     │ + instrumentation 起 WS     │ token 鉴权    │ fs/exec/pty   │
                                   └─────────────────────────────┘               └──────────────┘
                                                  共享 globalThis.__piRelayRegistry
```

- **浏览器 ↔ pi-web**：现有 HTTP + SSE（端口 30141），浏览器完全不碰本机 localhost。
- **Agent ↔ pi-web**：WebSocket（端口 30142，由 `instrumentation.ts` 拉起的独立
  `http.Server` 承载），Agent 主动外连，token 鉴权。
- 两个端口共享同一进程的 `globalThis.__piRelayRegistry`（配对码池 + 在线 Agent 连接）。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| Relay 核心 | `lib/relay/*.ts` | registry / pairing / relay-store / ws-server / forward / protocol |
| 浏览器侧路由 | `app/api/agent-relay/**` | pair、status、status/events(SSE)、rpc、rpc/stream(SSE)、download |
| WS 服务入口 | `instrumentation.ts` | `register()` 内启动 Relay http.Server（仅 server 阶段） |
| 前端 | `components/relay/*`、`hooks/useRelayAgent.ts`、`lib/relay-client.ts` | 顶栏按钮 + 配对模态 + 文件/命令面板 |
| Local Agent | `agent/**`（Go） | `pair` / `run` 子命令；静态二进制 |

## 配对流程（device code）

1. 浏览器点「连接本地机器」→ `POST /api/agent-relay/pair` 得到 6 位配对码（5 分钟有效）。
2. 模态展示下载命令 + `pi-agent pair --code <CODE> --server <RELAY_URL>`。
3. 用户在本地机器执行 → Agent `POST <RELAY>:30142/pair/exchange {code}` 换 token（写
   `~/.pi-agent/config.json`）。
4. Agent 连 `ws://<RELAY>:30142/ws?token=...`，发 `hello`（机器元信息）→ 注册为在线。
5. 浏览器经 SSE `/status/events` 感知在线 → 自动切换到「已连接」视图。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_RELAY_PORT` | `30142` | Agent 连接的 WS 端口 |
| `PI_RELAY_HOST` | `0.0.0.0` | WS 绑定地址（LAN/容器可达） |
| `PI_RELAY_ADVERTISE_URL` | _空_ | 反向代理场景下，对外可达的 Relay URL，浏览器据此拼 `--server` |
| `PI_RELAY_DISABLE` | _空_ | 设为 `1` 完全关闭 Relay（不影响 pi-web 其余功能） |

服务端 token 持久化在 `~/.pi/relay.json`（0600），重启 pi-web 后已配对的 Agent
无需重新配对即可重连。

## 部署注意

- **本地/LAN**：pi-web 默认监听 30141（`-H 127.0.0.1`，可用 `dev:lan`/`start:lan` 改
  `0.0.0.0`），Relay 监听 `0.0.0.0:30142`。Agent 用 `http://<pi-web 主机>:30142` 即可。
- **反向代理 / TLS**：若 pi-web 在 Nginx/Caddy 之后，需同时转发 30141 与 30142（后者要
  支持 WebSocket Upgrade）。建议在代理上做 TLS 终止，并设置
  `PI_RELAY_ADVERTISE_URL=https://ide.example.com/relay` 之类，浏览器据此生成正确命令。
- **Agent 与浏览器不同机**：浏览器用 `localhost` 访问 pi-web 时，生成的 `--server` 会是
  `localhost:30142`，远程 Agent 无法连接。请用 pi-web 服务器的实际地址访问，或设
  `PI_RELAY_ADVERTISE_URL`。

## 构建 Agent 二进制

```bash
cd pi-web/agent
export GOPROXY=https://goproxy.cn,direct   # 国内网络
./scripts/build.sh                          # 产出 dist/pi-agent-linux-{amd64,arm64}
```

`download` 路由会从 `pi-web/agent/dist/` 下发二进制与 `install.sh`，供
`curl …/install.sh | sh` 一键安装。

## 端到端验收（已在 Windows 主机用 windows 版 Agent 验证）

```bash
# 1) 浏览器侧
curl http://127.0.0.1:30141/api/agent-relay/status        # {"online":false,...}
CODE=$(curl -sX POST .../api/agent-relay/pair)             # 取 code

# 2) Agent 侧
pi-agent pair --code <CODE> --server http://<host>:30142
pi-agent run --root /path/to/share

# 3) RPC（经 pi-web 转发到 Agent）
curl -X POST .../api/agent-relay/rpc -d '{"method":"fs.list","params":{"path":"."}}'
curl -X POST .../api/agent-relay/rpc -d '{"method":"exec.run","params":{"argv":["uname","-a"]}}'
# 路径穿越被拒：fs.list {"path":"../../"} -> error "path outside workspace root"
```

## 安全

- 配对码：单次使用、5 分钟 TTL；换发 32 字节 token，服务端 0600 存储。
- WS 建连校验 token；非法立即关闭。
- Agent 侧 workspace root 强约束（含 `..`/符号链接穿越防护）；`exec.run` 仅 argv、无 shell。
- 浏览器侧路由复用 pi-web 现有 `proxy.ts`（可信主机 + 可选 Basic Auth）。
- MVP 单 Agent 槽位（多设备见 Phase 3）。

## 路线图

- **Phase 1（已完成）**：Relay + Agent + 配对 + 在线状态 + fs(list/read/write/stat/mkdir)
  + exec.run + 前端按钮/模态/面板。
- **Phase 2**：exec 流式、search.grep/fd（缺 rg/fd 退化 grep/find）、PTY 终端（xterm.js +
  ConPTY/pty）、fs.watch、把主 FileExplorer 与聊天 Agent 的 fs/bash 后端抽象为「local 或
  connected-agent」可切换。
- **Phase 3**：多 Agent/多设备、命令白名单/审计、端到端加密、Agent 自更新、本机托盘状态。
