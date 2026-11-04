#!/usr/bin/env bash
# Build the Linux GUI packages. The app is a MyGo native-UI binary (no cgo,
# no WebKitGTK): mygo embeds this module's resources, including the bundled
# agent-client CLI for each architecture.
#
#   ./scripts/build-linux.sh              # linux/amd64 + linux/arm64
#
# Output (agent/gui/build/linux-<arch>/):
#   agent-client-gui                         the executable
#   agent-client-gui-<version>-linux-<arch>.tar.gz   with install.sh
#   agent-client-gui_<version>_<arch>.deb
#
# Requires Go on PATH (agent-client and the GUI are pure Go).
set -euo pipefail

cd "$(dirname "$0")/.." # agent/gui
GUI_DIR="$(pwd)"
AGENT_DIR=".."          # agent/

for arch in amd64 arm64; do
  echo "==> agent-client linux/$arch"
  mkdir -p "resources/linux-$arch/bin"
  (
    cd "$AGENT_DIR"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
      go build -trimpath -ldflags "-s -w" -o "$GUI_DIR/resources/linux-$arch/bin/agent-client" .
  )
  chmod +x "resources/linux-$arch/bin/agent-client"
done

echo "==> mygo build (linux/amd64,linux/arm64)"
go tool mygo build -platform linux/amd64,linux/arm64

# Windows-created archives lose the executable bits; restore them in the
# packages (and in the plain build outputs) before anyone installs them.
echo "==> fixing executable bits"
chmod +x build/linux-amd64/agent-client-gui build/linux-arm64/agent-client-gui
go run ./scripts/fixmodes \
  build/linux-amd64/*.tar.gz build/linux-amd64/*.deb \
  build/linux-arm64/*.tar.gz build/linux-arm64/*.deb

echo "==> artifacts"
ls -lh build/linux-amd64/agent-client-gui build/linux-amd64/*.tar.gz build/linux-amd64/*.deb 2>/dev/null || true
ls -lh build/linux-arm64/agent-client-gui build/linux-arm64/*.tar.gz build/linux-arm64/*.deb 2>/dev/null || true
