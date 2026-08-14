# pi-agent — Local Machine Bridge for pi-web

A single static Go binary that runs on the user's machine (e.g. **CentOS 7**),
connects out to the pi-web relay over WebSocket, and serves file + command
requests scoped to a workspace root. This is the local half of pi-web's
"连接本地机器" feature.

It has **no runtime dependencies** (`CGO_ENABLED=0`, statically linked), so it
runs on old distros without installing Node, Python, or any libraries.

## Build

Requires Go 1.22+ on PATH.

```bash
cd agent
export GOPROXY=https://goproxy.cn,direct   # if proxy.golang.org is unreachable
./scripts/build.sh                          # -> dist/pi-agent-linux-{amd64,arm64}, .exe
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
pi-agent pair --code 3JFSG6 --server http://<RELAY_HOST>:30142 [--root /path/to/share]
#    -> writes ~/.pi-agent/config.json (mode 0600)

# 2) run (persistent loop; auto-reconnects)
pi-agent run [--root /path/to/share]
```

`<RELAY_HOST>:30142` is the pi-web relay endpoint (port `PI_RELAY_PORT`,
default 30142). `<PIWEB_BASE>` is the web port (30141). They share a host; the
two ports differ.

### Run as a service (CentOS 7 / systemd)

```bash
sudo cp contrib/pi-agent.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/pi-agent.service   # set ExecStart/User/WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now pi-agent
journalctl -u pi-agent -f
```

Pair once interactively as the service user first, so `~/.pi-agent/config.json`
exists.

## Commands

| Command | Description |
|---|---|
| `pi-agent pair --code CODE --server URL [--root PATH]` | exchange code for token, save config |
| `pi-agent run [--config FILE] [--root PATH]` | connect & serve (default subcommand) |
| `pi-agent version` | print version |
| `pi-agent help` | usage |

## Security model

- **Workspace root**: all `fs.*` calls are confined to the root (resolved
  against symlinks, `..` and absolute escapes rejected). `--root` / config
  `workspaceRoot` / cwd (in that priority). Default is the run cwd.
- **No shell**: `exec.run` takes an `argv` array and spawns directly — there is
  no shell-injection surface.
- **Token**: the pairing code is single-use + 5-min TTL; it is exchanged for a
  32-byte token stored at `~/.pi-agent/config.json` (0600). The same token is
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
