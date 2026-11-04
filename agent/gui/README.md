# Agent Client GUI (Linux)

A small desktop client for the `agent-client` CLI: paste the pairing command
from pi-web's "连接本地机器" dialog, and the app fills the relay address and
pairing code, pairs the machine, and keeps one connection per saved server.
The CLI stays unchanged and usable on its own; this app shells out to the
bundled `agent-client` binary.

## Features

- Paste the whole pairing line (`./agent-client pair --code … --server …`) or
  just a code / URL; the address and code are filled automatically.
- Remembered relay address and client name (a name left empty is not sent, so
  the CLI keeps the machine's existing name).
- Saved servers come from `~/.agent-client/config.json`,
  `~/.agent-client/profiles/*.json` and the legacy `~/.pi-agent/config.json`;
  a config the CLI wrote elsewhere is picked up from its `token saved to …`
  line, so the list is never empty right after a successful pairing.
- Pairing a new server connects it automatically; every server can be
  connected/disconnected on its own afterwards.
- Connect/disconnect several servers at once; per-server status
  (connecting / connected / reconnecting / failed), version and workspace root.
- Bundles the matching `agent-client` for each architecture, so installing the
  GUI does not require a separate CLI install.

## Build (from `agent/gui`)

```bash
./scripts/build-linux.sh          # linux/amd64 + linux/arm64
```

Outputs in `build/linux-<arch>/`: the executable, a `.tar.gz` with `install.sh`
(installs per-user under `~/.local`), and a `.deb`.

## Development

```bash
go test ./...
go tool mygo dev                  # window with live reload
PI_AGENT_CLIENT=/path/to/agent-client go tool mygo dev   # use a specific CLI
```

The GUI looks for `agent-client` in this order: `$PI_AGENT_CLIENT`, the app
resources (`bin/agent-client`), next to the executable, the repo's
`agent/dist` (development), then `PATH`. A resource without the executable bit
(tar built on Windows) is chmod-ed, or copied to
`~/.local/share/agent-client-gui/bin` when the install is read-only.
