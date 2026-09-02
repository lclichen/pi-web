#!/usr/bin/env sh
# pi-agent installer, designed for `curl ... | sh`:
#
#   curl -fsSL <PIWEB_BASE>/api/agent-relay/download/install.sh | sh -s -- <PIWEB_BASE> [arch]
#
# Where <PIWEB_BASE> is the pi-web origin, e.g. http://192.168.1.10:30141, and
# [arch] is amd64|arm64 (auto-detected from uname -m when omitted). Downloads the
# matching static Linux binary, marks it executable, and installs it to
# /usr/local/bin/pi-agent when writable (falling back to ./pi-agent).
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

URL="${BASE%/}/api/agent-relay/download/pi-agent-linux-${ARCH}"
TMP="$(mktemp -t pi-agent.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

echo "Downloading $URL ..."
curl -fsSL -o "$TMP" "$URL"
chmod +x "$TMP"

DST_DIR="/usr/local/bin"
if [ -w "$DST_DIR" ] || sudo -n true 2>/dev/null; then
  if [ -w "$DST_DIR" ]; then
    install -m 0755 "$TMP" "$DST_DIR/pi-agent"
  else
    sudo install -m 0755 "$TMP" "$DST_DIR/pi-agent"
  fi
  echo "Installed: $(command -v pi-agent 2>/dev/null || echo "$DST_DIR/pi-agent")"
else
  mv "$TMP" ./pi-agent
  chmod +x ./pi-agent
  trap - EXIT
  echo "Installed: ./pi-agent (not on PATH; /usr/local/bin not writable)"
fi

echo "Next: pi-agent pair --code CODE --server <RELAY_URL>"
