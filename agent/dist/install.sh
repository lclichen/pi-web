#!/usr/bin/env sh
# agent-client installer, designed for `curl ... | sh`:
#
#   curl -fsSL <PIWEB_BASE>/api/agent-relay/download/install.sh | sh -s -- <PIWEB_BASE> [arch]
#
# Where <PIWEB_BASE> is the pi-web origin, e.g. http://192.168.1.10:30141, and
# [arch] is amd64|arm64 (auto-detected from uname -m when omitted). Downloads the
# matching static Linux/macOS binary, marks it executable, and installs it to
# /usr/local/bin/agent-client when writable (falling back to ./agent-client).
# A legacy `pi-agent` symlink is created next to it when possible.
set -eu

BASE="${1:-}"
ARCH="${2:-}"

if [ -z "$BASE" ]; then
  echo "install.sh: missing PIWEB_BASE argument" >&2
  echo "usage: curl -fsSL <BASE>/api/agent-relay/download/install.sh | sh -s -- <BASE> [amd64|arm64]" >&2
  exit 2
fi

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "install.sh: unsupported arch '$(uname -m)'; pass it explicitly" >&2; exit 2 ;;
  esac
fi

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  *) OS=linux ;;
esac

URL="${BASE%/}/api/agent-relay/download/agent-client-${OS}-${ARCH}"
TMP="$(mktemp -t agent-client.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

echo "Downloading $URL ..."
curl -fsSL -o "$TMP" "$URL"
chmod +x "$TMP"

# Legacy alias so existing scripts/configs that call `pi-agent` keep working.
# A previously installed regular pi-agent binary is replaced by the symlink so
# old units cannot keep running the outdated version.
link_legacy() {
  dir="$1"
  ln -sf agent-client "$dir/pi-agent" 2>/dev/null || true
}

install_into() {
  dir="$1"
  if [ -w "$dir" ]; then
    install -m 0755 "$TMP" "$dir/agent-client"
    link_legacy "$dir"
  else
    sudo install -m 0755 "$TMP" "$dir/agent-client"
    sudo ln -sf agent-client "$dir/pi-agent" 2>/dev/null || true
  fi
}

DST_DIR="/usr/local/bin"
if [ -w "$DST_DIR" ] || sudo -n true 2>/dev/null; then
  install_into "$DST_DIR"
  echo "Installed: $(command -v agent-client 2>/dev/null || echo "$DST_DIR/agent-client")"
else
  mv "$TMP" ./agent-client
  chmod +x ./agent-client
  trap - EXIT
  echo "Installed: ./agent-client (not on PATH; /usr/local/bin not writable)"
fi

echo "Next: agent-client pair --code CODE --server <RELAY_URL>"
