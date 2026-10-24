#!/usr/bin/env bash
# Cross-compile agent-client into static binaries for distribution.
#
# Produces dist/agent-client-linux-{amd64,arm64}, dist/agent-client-darwin-{amd64,arm64}
# and dist/agent-client-windows-amd64.exe. CGO is disabled so the Linux binaries
# are fully statically linked and run on old distros like CentOS 7 (glibc 2.17)
# with zero runtime dependencies.
#
# Usage:
#   ./scripts/build.sh                 # build all targets
#   ./scripts/build.sh linux-amd64     # build one target
#
# Requires Go (https://go.dev/dl/) on PATH. If you are behind the GFW, set
#   export GOPROXY=https://goproxy.cn,direct
# before running.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

LDFLAGS="-s -w"
TARGETS=("linux-amd64" "linux-arm64" "darwin-amd64" "darwin-arm64" "windows-amd64")

if [[ $# -ge 1 ]]; then
  TARGETS=("$@")
fi

for target in "${TARGETS[@]}"; do
  os="${target%-*}"
  arch="${target#*-}"
  out="dist/agent-client-${target}"
  [[ "$os" == "windows" ]] && out="${out}.exe"
  echo "==> building ${target} -> ${out}"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$out" .
done

echo "==> done. artifacts:"
ls -la dist/
