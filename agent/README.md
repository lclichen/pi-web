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
agent-client pair --code 3JFSG6 --server http://<RELAY_HOST>:30142 [--root /path/to/share]
#    -> writes ~/.agent-client/config.json (mode 0600)

# 2) run (persistent loop; auto-reconnects)
agent-client run [--root /path/to/share]
```

`<RELAY_HOST>:30142` is the pi-web relay endpoint (port `PI_RELAY_PORT`,
default 30142). `<PIWEB_BASE>` is the web port (30141). They share a host; the
two ports differ.

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
| `agent-client pair --code CODE --server URL [--root PATH]` | exchange code for token, save config |
| `agent-client run [--config FILE] [--root PATH]` | connect & serve (default subcommand) |
| `agent-client version` / `--version` / `-V` | print version |
| `agent-client help` | usage |

## Security model

- **Workspace root**: all `fs.*` calls are confined to the root (resolved
  against symlinks, `..` and absolute escapes rejected). `--root` / config
  `workspaceRoot` / cwd (in that priority). Default is the run cwd.
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
- **No shell**: `exec.run` takes an `argv` array and spawns directly — there is
  no shell-injection surface.
- **Token**: the pairing code is single-use + 5-min TTL; it is exchanged for a
  32-byte token stored at `~/.agent-client/config.json` (0600). The same token is
  stored server-side at `~/.pi/relay.json` (0600).
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
