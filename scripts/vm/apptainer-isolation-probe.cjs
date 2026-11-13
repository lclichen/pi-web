#!/usr/bin/env node
/**
 * Apptainer isolation regression probe (ADR 0004 §0).
 *
 * The projection/promotion gates assume the sandbox cannot see the Host
 * project area. Current executors start Apptainer with
 * `--contain --no-mount hostfs,cwd`; this probe re-checks the flags and, when a
 * container is running, verifies inside the instance that the Host project
 * area and ~/.ssh are invisible/not writable.
 *
 * Usage:
 *   node scripts/vm/apptainer-isolation-probe.cjs
 */
const { withConnection } = require("./lib.cjs");

const REMOTE_SCRIPT = `
set -u
P=/home/llmx/amedac/sandbox-platform/src/executors
fail=0
check_flag() {
  file="$1"; flag="$2"
  if grep -q -- "$flag" "$file"; then
    echo "OK  $(basename "$file") $flag"
  else
    echo "FAIL $(basename "$file") missing $flag"
    fail=1
  fi
}
check_flag "$P/apptainer-cli-executor.ts" "--contain"
check_flag "$P/apptainer-cli-executor.ts" "--no-mount"
check_flag "$P/ssh-executor.ts" "--contain"
check_flag "$P/ssh-executor.ts" "--no-mount"

INSTANCE=$(python3 - <<'PY'
import sqlite3
try:
    db = sqlite3.connect('/home/llmx/amedac/sandbox-platform/data/sandbox.db')
    rows = list(db.execute("select instance_name from containers where status='running' and node='local' limit 1"))
    print(rows[0][0] if rows else "")
except Exception:
    print("")
PY
)
if [ -z "$INSTANCE" ]; then
  echo "SKIP no local running container for the in-instance probe"
  exit $fail
fi

echo "== in-instance probe: $INSTANCE"
timeout 40 apptainer exec instance://"$INSTANCE" sh -c '
  if test -e /home/llmx/amedac/piweb-data/.pi/auth.json; then
    echo "FAIL project auth.json is visible"
    exit 1
  fi
  if test -e /home/llmx/.ssh; then
    echo "FAIL host ~/.ssh is visible"
    exit 1
  fi
  if touch /home/llmx/amedac/piweb-data/.isolation-probe 2>/dev/null; then
    rm -f /home/llmx/amedac/piweb-data/.isolation-probe 2>/dev/null
    echo "FAIL host project area is writable"
    exit 1
  fi
  echo "OK  project area and ~/.ssh are invisible/not writable"
' || fail=1
exit $fail
`;

withConnection(async (vm) => {
  const result = await vm.exec(REMOTE_SCRIPT, { timeoutSec: 120 });
  vm.end();
  process.exitCode = result.code === 0 ? 0 : 1;
});
