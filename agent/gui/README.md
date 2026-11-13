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
- Saved servers come from the CLI's single store
  `~/.agent-client/config.json` (0.5.0+ `servers` map). Older layouts
  (`profiles/*.json`, the legacy `~/.pi-agent/config.json`) are still listed;
  a config the CLI wrote elsewhere is picked up from its `token saved to …`
  line, so the list is never empty right after a successful pairing.
- Pairing a new server connects it automatically; every server can be
  connected/disconnected on its own afterwards. Each connection is started as
  `agent-client run --server <url>` from the shared config file.
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

## Known Linux rendering issues (fixed in this build)

- **Subpixel text (MyGo #1025 / PR #1027):** MyGo ≤ 0.7.4 rendered Linux subpixel
  glyphs with FreeType's legacy LCD filter on cairo < 1.17 (CentOS 7, Ubuntu
  18.04 and similar): dark text looked pale, with a white core and colored
  (green) fringes.
- **Light/dark mismatch (MyGo #1120 / PR #1123):** GTK 3 does not read the
  settings portal's color scheme, so a light desktop could keep GTK's dark
  default and paint white text in a white native-UI window. MyGo now applies
  `gtk-application-prefer-dark-theme` at startup and when the portal changes;
  this app also calls `Theme.SetSource(ThemeSystem)` before `App.Run`.

Both fixes landed after v0.7.4 and before any newer release, so this module
pins the commit that contains them. If fringes or mismatched colors persist,
switch GTK to grayscale and report your cairo/desktop versions:

```bash
gsettings set org.gnome.desktop.interface font-antialiasing 'grayscale'
# or ~/.config/gtk-3.0/settings.ini:
# [Settings]
# gtk-xft-antialias=1
# gtk-xft-rgba=none
```

`MYGO_GPU=0 ./agent-client-gui` forces MyGo's CPU renderer (useful to tell a GPU
driver problem from a font-rendering one).

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
