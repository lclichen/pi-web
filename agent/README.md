# agent-client — local workspace client for pi-web

A single static Go binary that runs on the user's machine (e.g. **CentOS 7**),
connects out to the pi-web relay over WebSocket, and serves file + command
requests scoped to a workspace root. This is the local half of pi-web's
"连接本地机器" feature. Renamed from `pi-agent` in 0.3.0: the installer also
creates a `pi-agent` symlink, and legacy `~/.pi-agent/config.json` credentials
are read (and kept) automatically.

It has **no runtime dependencies** (`CGO_ENABLED=0`, statically linked), so it
runs on old distros without installing Node, Python, or any libraries.

## Build

Requires Go 1.22+ on PATH.

```bash
cd agent
export GOPROXY=https://goproxy.cn,direct   # if proxy.golang.org is unreachable
./scripts/build.sh                          # -> dist/agent-client-{linux,darwin}-{amd64,arm64}, .exe
```

## Install on the target machine

Either download via pi-web (the UI shows the exact commands), or directly:

```bash
# one-shot via the relay-served installer (PIWEB_BASE = pi-web origin, e.g. http://host:30141)
curl -fsSL http://<PIWEB_BASE>/api/agent-relay/download/install.sh | sh -s -- http://<PIWEB_BASE> amd64
```

## Pair + run

```bash
# 1) pair (the code + relay URL come from pi-web's "连接本地机器" dialog)
./agent-client pair --code 3JFSG6 --server http://<RELAY_HOST>:30142 [--root /path/to/share]
#    (installed in PATH? run `agent-client` without ./)
#    -> writes/updates ONE file: ~/.agent-client/config.json (mode 0600)
#       each connection is an entry in "servers", keyed by relay URL

# 2) connect
./agent-client run                        # terminal: pick from a list and stay in control
./agent-client run --server URL           # scripts / systemd: connect to one entry
./agent-client run --list                 # show saved connections and the current one
#    started in a project directory? that directory becomes the workspace root
```

`<RELAY_HOST>:30142` is the pi-web relay endpoint (port `PI_RELAY_PORT`,
default 30142). `<PIWEB_BASE>` is the web port (30141). They share a host; the
two ports differ.

**Workspace root** is re-evaluated on every `run` (0.4.1+): `--root` wins;
otherwise a cwd that is a real project directory (not `/`, not the home dir)
becomes the root, so starting the client from another path switches it there
instead of resurrecting a stale saved path. Service units (`cwd=/` or home) keep
using the saved root; a saved root that no longer exists is dropped with a log
warning and falls back to the home dir. The resolved root is persisted **per
connection**, so the WebUI always sees the directory the running client
actually serves.

### Interactive mode (0.5.0+)

Started from a terminal (or with `--interactive`), `run` opens a three-zone
screen and stays open, so adding / switching / disconnecting / re-pairing no
longer needs a restart:

```
┌ 日志区：connecting / connected / reconnecting / re-pair errors scroll here
├ 状态区：Agent Client — 已保存的连接
│         [1] http://10.99.9.7:30142  实验室服务器  已连接
│         [2] http://10.0.0.5:30142   工位机        未连接
│         编号=连接/切换  n=新建连接  d=断开  r=重新配对  l=刷新  q=退出
└ 交互区：请选择（编号或 n/d/r/l/q）：
```

The status zone refreshes itself the moment a connection changes (connected,
reconnecting, token expired, duplicate refusal) — no Enter or `l` needed — and
the prompt/log rows stay pinned instead of scrolling the menu away. It uses the
terminal's alternate screen and is enabled only for a real TTY; pipes and
`TERM=dumb` fall back to the plain line-oriented output. On Windows VT escape
processing is enabled when the console supports it, otherwise the fallback is
used.

- `n` pairs a new relay without leaving the menu: paste the whole
  `./agent-client pair --code … --server …` line from pi-web (or just the relay
  address/host:port), then the code and an optional client name. On success it
  saves the connection and connects to it.
- `r` stops the current connection and asks for a fresh pairing code, then
  saves the new token in place and reconnects. Use it whenever a token is
  revoked or expired (`token 失效` shows in the list) — there is no need to
  delete the client or its config.

In a service or script (no TTY) `run` connects to `--server`, else the last
used / only saved connection.

### Multiple pi-web servers on one machine (0.5.0+)

Every connection lives in the same `~/.agent-client/config.json` map:

```json
{
  "version": 2,
  "current": "http://10.0.0.5:30142",
  "servers": {
    "http://10.99.9.7:30142": { "server": "...", "token": "...", "machineId": "...", "label": "实验室服务器" },
    "http://10.0.0.5:30142":  { "server": "...", "token": "...", "machineId": "...", "label": "工位机" }
  }
}
```

Pairing another server adds an entry instead of creating a second file; each
entry keeps its own token, machine id, label and workspace root. Existing
installs are migrated automatically on first load: the old single config, the
0.4.x `~/.agent-client/profiles/*.json` files and the pre-0.3
`~/.pi-agent/config.json` are merged into the map (the old files are left in
place as a backup). `--config FILE` still selects an arbitrary file.

### Duplicate connections and token rotation (0.5.0+)

- The client sends a per-process `X-Agent-Instance` id when it connects. The
  relay remembers it and refuses a **second live client for the same machine**
  with HTTP 409 (`该机器已在另一个客户端连接（hostname，vX.Y.Z）`). The
  already-running client keeps its connection instead of being silently
  evicted.
- A reconnect of the same process (network blip) is always accepted. To
  deliberately take over, start the second client with `--replace`.
- `pair` refuses to rotate the token of a machine that is currently connected
  (that rotation would strand the live client at its next reconnect) unless
  `--force` is given. With `--force` the relay closes the old connection after
  issuing the new token.

### Run as a service (CentOS 7 / systemd)

```bash
sudo cp contrib/agent-client.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/agent-client.service   # set ExecStart/User/WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now agent-client
journalctl -u agent-client -f
```

Pair once interactively as the service user first, so `~/.agent-client/config.json`
exists.

## Commands

| Command | Description |
|---|---|
| `agent-client pair --code CODE --server URL [--root PATH] [--label NAME] [--force]` | exchange code for token, save/update the connection in the config map (`--force` rotates a connected machine's token) |
| `agent-client run [--config FILE] [--server URL] [--root PATH] [--replace] [--interactive] [--list]` | connect & serve (default subcommand); interactive on a TTY |
| `agent-client version` / `--version` / `-V` | print version |
| `agent-client help` | usage |

## Security model

- **Workspace root**: all `fs.*` calls are confined to the root (resolved
  against symlinks, `..` and absolute escapes rejected). Priority: `--root` /
  the cwd the client was started in (when it is a project directory) / the
  saved root (service cwd) / home. The resolved value is persisted on every
  run.
- **Version handshake**: the WebUI requires `agent-client >= 0.3.0`. Pairing
  sends `clientVersion` and is rejected with HTTP 426 when too old; the hello
  frame reports `agentVersion` and `features`, and the WebUI flags an outdated
  client before starting project/batch work.
- **Per-request base (0.2.0+)**: every `fs.*` / `search.*` / `exec.*` /
  `pty.create` request may carry an absolute `base` directory; relative paths
  then resolve inside it (with the same `..`/symlink fence). pi-web uses this
  to scope a local-machine project to its own workspace directory while
  several projects share one agent connection. The agent advertises the
  capability as `features: ["workspace-base"]` in its hello frame; older
  agents ignore `base` and stay confined to the root.
- **Binary reads (0.4.0+)**: `fs.read` accepts `encoding: "base64"` and returns
  `contentBase64`, so images/audio/video previews survive the JSON hop (plain
  JSON strings mangle invalid UTF-8). Advertised as
  `features: ["workspace-base", "binary-read"]`; pi-web falls back to a
  `base64 -w0` exec for older agents and shows an upgrade hint if neither works.
- **No shell**: `exec.run` takes an `argv` array and spawns directly — there is
  no shell-injection surface.
- **Token**: the pairing code is single-use + 5-min TTL; it is exchanged for a
  32-byte token stored per connection in `~/.agent-client/config.json` (0600).
  The same token is stored server-side at `~/.pi/relay.json` (0600) and refreshed
  on every connect (90-day rolling expiry). A revoked/expired token is fixed by
  re-pairing, not by deleting the client.
- **Duplicate protection (0.5.0+)**: the relay pairs `X-Agent-Instance` with the
  machine slot and answers a second live process with 409 instead of closing
  the existing connection; `pair` answers 409 while the machine is online
  unless `--force` is used.
- **Outbound only**: the agent dials the relay; no port is opened on the user's
  machine.

## Protocol

JSON-RPC over one WebSocket. Methods: `workspace.info`, `fs.list`, `fs.read`,
`fs.write`, `fs.stat`, `fs.mkdir`, `fs.delete`, `fs.rename`, `search.grep`,
`search.fd`, `exec.run`, `exec.stream`, `pty.create`, `pty.input`,
`pty.resize`, `pty.close`. Pending: `fs.watch`. The shapes live in
`internal/protocol/protocol.go` (mirrors `pi-web/lib/relay/protocol.ts`).

The interactive terminal (`pty.*`) uses **creack/pty** (pure Go, CGO-free → the
Linux binary stays statically linked). It is built only on Linux/macOS; on
Windows the agent compiles with a stub so the rest still runs — runtime PTY
testing happens on the CentOS 7 target. PTY output is pushed as unsolicited
`{type:"event", event:"pty.output", sessionId, data}` frames.

`search.grep`/`search.fd` are **Go-native** (tree walk + `regexp`) — they do not
shell out to rg/fd/grep/find, so behavior is identical on CentOS 7 and elsewhere
and the binary stays dependency-free. Heavy dirs (`node_modules`, `.git`, ...)
are skipped during traversal.
