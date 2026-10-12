const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

// 实机冒烟（runbook DEP-04）：admin 登录 → host 会话 ensure_session →
// 真实模型 prompt → 轮询 settle → 断言 assistant 文本非空。
// 凭据全部来自 vm-credentials.cjs（gitignored）或环境变量，绝不硬编码。
const BASE = 'http://127.0.0.1:30141';
const CWD = '/home/llmx/lab-demo-web';
const PROMPT = '用一句话介绍你能使用哪些工具类别（不要逐个列工具名，也不要调用任何工具）';
const PASSWORD = process.env.VM_APP_ADMIN_PASSWORD || require('./vm-credentials.cjs').appAccounts.admin;

const remote = `#!/bin/bash
set -u
COOKIE=$(curl -s -m 10 -c - -X POST ${BASE}/api/webauth/login -H 'content-type: application/json' -H 'origin: ${BASE}' -d '{"username":"admin","password":"${PASSWORD}"}' | grep pi_web_sid | awk '{print $7}')
[ -z "$COOKIE" ] && { echo "LOGIN-FAILED"; exit 1; }
RESP=$(curl -s -m 20 -X POST ${BASE}/api/agent/new -H 'content-type: application/json' -H 'origin: ${BASE}' -H "cookie: pi_web_sid=$COOKIE" -d '{"mode":"host","cwd":"${CWD}","type":"ensure_session"}')
SID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sessionId",""))')
[ -z "$SID" ] && { echo "NO-SESSION: $RESP"; exit 1; }
echo "sid: $SID"
curl -s -m 20 -X POST ${BASE}/api/agent/$SID -H 'content-type: application/json' -H 'origin: ${BASE}' -H "cookie: pi_web_sid=$COOKIE" -d '{"type":"prompt","message":"${PROMPT}"}' >/dev/null
for i in $(seq 1 60); do
  R=$(curl -s -m 5 ${BASE}/api/agent/running -H "cookie: pi_web_sid=$COOKIE" | grep -o "\\"$SID\\"" | head -1)
  [ -z "$R" ] && break
  sleep 5
done
echo "settled ~$((i*5))s"
F=$(find /home/llmx/.pi/agent/sessions -name "*$SID*" 2>/dev/null | head -1)
[ -z "$F" ] && { echo "SESSION-FILE-MISSING"; exit 1; }
python3 - "$F" <<'PYEOF'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1], encoding='utf8') if l.strip()]
asst = [e for e in lines if (e.get('message') or {}).get('role') == 'assistant']
text = ''
if asst:
    c = asst[-1]['message']['content']
    if isinstance(c, list):
        text = ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
    elif isinstance(c, str):
        text = c
print('assistant-text-len:', len(text))
print(text[:300])
sys.exit(0 if len(text.strip()) > 0 else 2)
PYEOF
RC=$?
[ $RC -eq 0 ] && echo SMOKE-PASS || echo SMOKE-FAIL
exit $RC
`;

const b64 = Buffer.from(remote, 'utf8').toString('base64');
conn.on('ready', () => {
  conn.exec(`printf %s '${b64}' | base64 -d > /tmp/vm-smoke-session.sh && timeout 420 bash /tmp/vm-smoke-session.sh`, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = '';
    stream.on('data', (d) => out += d).stderr.on('data', (d) => out += d);
    stream.on('close', (code) => { console.log(out.trim()); conn.end(); process.exit(code || 0); });
  });
});
conn.connect(loadVmConnection());
