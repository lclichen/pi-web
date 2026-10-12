const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

// F-05 子智能体 e2e（runbook §7）：spawn → 嵌套识别 → viewer 数据面 → sessionId 透传。
// 前置：tintinweb fork dist 已同步（§7.1）且 pi-web 已重启。
const BASE = 'http://127.0.0.1:30141';
const CWD = '/home/llmx/lab-demo-web';
const PROMPT = '请用 Agent 工具启动一个子智能体，任务：查看当前目录并回答其中有哪些文件，完成后回复 DONE。等待子智能体结束并用一句话汇报它的结果。';
const PASSWORD = process.env.VM_APP_ADMIN_PASSWORD || require('./vm-credentials.cjs').appAccounts.admin;

const remote = `#!/bin/bash
set -u
J="python3 -c"
COOKIE=$(curl -s -m 10 -c - -X POST ${BASE}/api/webauth/login -H 'content-type: application/json' -H 'origin: ${BASE}' -d '{"username":"admin","password":"${PASSWORD}"}' | grep pi_web_sid | awk '{print $7}')
[ -z "$COOKIE" ] && { echo "LOGIN-FAILED"; exit 1; }
RESP=$(curl -s -m 20 -X POST ${BASE}/api/agent/new -H 'content-type: application/json' -H 'origin: ${BASE}' -H "cookie: pi_web_sid=$COOKIE" -d '{"mode":"host","cwd":"${CWD}","type":"ensure_session"}')
SID=$(echo "$RESP" | $J 'import json,sys; print(json.load(sys.stdin).get("sessionId",""))')
[ -z "$SID" ] && { echo "NO-SESSION: $RESP"; exit 1; }
echo "parent-sid: $SID"
curl -s -m 20 -X POST ${BASE}/api/agent/$SID -H 'content-type: application/json' -H 'origin: ${BASE}' -H "cookie: pi_web_sid=$COOKIE" -d '{"type":"prompt","message":"${PROMPT}"}' >/dev/null
for i in $(seq 1 72); do
  R=$(curl -s -m 5 ${BASE}/api/agent/running -H "cookie: pi_web_sid=$COOKIE" | grep -o "\\"$SID\\"" | head -1)
  [ -z "$R" ] && break
  sleep 5
done
echo "settled ~$((i*5))s"

echo "=== A: 嵌套识别（/api/sessions）==="
curl -s -m 10 ${BASE}/api/sessions -H "cookie: pi_web_sid=$COOKIE" > /tmp/sub-e2e-sessions.json
CHILD=$(python3 - "$SID" <<'PYEOF'
import json, sys
parent = sys.argv[1]
sessions = json.load(open('/tmp/sub-e2e-sessions.json'))
flat = []
for group in (sessions if isinstance(sessions, list) else sessions.get('sessions', [])):
    if isinstance(group, dict) and 'sessions' in group:
        flat += group['sessions']
    else:
        flat.append(group)
for s in flat:
    if s.get('id') == parent:
        continue
    rel = s.get('relation') or {}
    if rel.get('kind') == 'subagent' or s.get('parentSessionId') == parent:
        print('child-id:', s['id'])
        print('child-name:', s.get('name'))
        print('relation:', json.dumps(rel, ensure_ascii=False))
        print('parent-match:', s.get('parentSessionId') == parent)
        break
PYEOF
)
FIRST=$(echo "$CHILD" | grep '^child-id:' | awk '{print $2}')
[ -z "$FIRST" ] && { echo "A-FAIL: no child session recognized"; exit 2; }
echo "$CHILD"

echo "=== B: viewer 数据面（/api/sessions/<child>/context）==="
CTX=$(curl -s -m 10 -o /tmp/sub-e2e-ctx.json -w '%{http_code}' ${BASE}/api/sessions/$FIRST/context -H "cookie: pi_web_sid=$COOKIE")
echo "context-http: $CTX"
python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/sub-e2e-ctx.json'))
ctx = d.get('context') or {}; entries = ctx.get('messages', []) if isinstance(ctx, dict) else []
print('context-messages:', len(entries)); ok = len(entries) > 0; print('B-ASSERT:', 'PASS' if ok else 'FAIL'); sys.exit(0 if ok else 4)
PYEOF

echo "=== C: 父会话 Agent 结果 sessionId 透传 ==="
F=$(find /home/llmx/.pi/agent/sessions -name "*$SID*" 2>/dev/null | head -1)
[ -z "$F" ] && { echo "C-FAIL: parent file missing"; exit 3; }
grep -c "sessionId" "$F" | sed 's/^/parent-file-sessionId-hits: /'

echo "SUB-E2E-DONE sid=$SID child=$FIRST"
`;

const b64 = Buffer.from(remote, 'utf8').toString('base64');
conn.on('ready', () => {
  conn.exec(`printf %s '${b64}' | base64 -d > /tmp/subagent-e2e.sh && timeout 480 bash /tmp/subagent-e2e.sh`, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = '';
    stream.on('data', (d) => out += d).stderr.on('data', (d) => out += d);
    stream.on('close', (code) => { console.log(out.trim()); conn.end(); process.exit(code || 0); });
  });
});
conn.connect(loadVmConnection());
