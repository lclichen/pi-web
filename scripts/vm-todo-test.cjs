const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

const remote = `#!/bin/bash
export PATH=/home/llmx/tools/node/bin:$PATH
BASE=http://127.0.0.1:30141
D=/home/llmx/lab-demo-web
OUT=/tmp/todo-results.txt
: > $OUT

COOKIE=$(curl -s -m 10 -c - -X POST $BASE/api/webauth/login -H 'content-type: application/json' -H 'origin: http://127.0.0.1:30141' -d '{"username":"admin","password":"changeme123"}' # secret-scan:allow | grep pi_web_sid | awk '{print $7}')
RESP=$(curl -s -m 20 -X POST $BASE/api/agent/new -H 'content-type: application/json' -H 'origin: http://127.0.0.1:30141' -H "cookie: pi_web_sid=$COOKIE" -d "{\\"mode\\":\\"host\\",\\"cwd\\":\\"$D\\",\\"type\\":\\"ensure_session\\"}")
SID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sessionId",""))')
echo "sid: $SID" >> $OUT

curl -s -m 20 -X POST $BASE/api/agent/$SID -H 'content-type: application/json' -H 'origin: http://127.0.0.1:30141' -H "cookie: pi_web_sid=$COOKIE" -d '{"type":"prompt","message":"请调用 todo 工具，写入恰好两条待办：第一条 pending 内容为 阅读文档，第二条 in_progress 内容为 运行测试。写完后不要再做别的，直接简短确认。"}' >> $OUT 2>&1
echo "" >> $OUT

for i in $(seq 1 36); do
  R=$(curl -s -m 5 $BASE/api/agent/running -H "cookie: pi_web_sid=$COOKIE" | grep -o "\\"$SID\\"" | head -1)
  [ -z "$R" ] && break
  sleep 5
done
echo "settled ~$((i*5))s" >> $OUT

F=$(find /home/llmx/.pi/agent/sessions -name "*$SID*" 2>/dev/null | head -1)
echo "file: $F" >> $OUT
python3 - "$F" >> $OUT 2>&1 <<'PYEOF'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1], encoding='utf8') if l.strip()]
tool_calls = []
for e in lines:
    m = e.get('message') or {}
    c = m.get('content')
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get('type') == 'toolCall' and 'todo' in (b.get('name') or ''):
                tool_calls.append(b.get('input'))
print('todo-tool-calls:', len(tool_calls))
for inp in tool_calls[:2]:
    s = json.dumps(inp, ensure_ascii=False)
    print('V2-SINGLE-PARAM:', '"todos"' in s or '"list"' in s, '| keys:', list(inp.keys()) if isinstance(inp, dict) else '?')
    print('payload-head:', s[:220])
# todo 详情快照（v2 应为整表）
for e in lines:
    if e.get('type') == 'toolResult':
        pass
PYEOF
echo DONE >> $OUT
`;

const b64 = Buffer.from(remote, 'utf8').toString('base64');
conn.on('ready', () => {
  conn.exec(`printf %s '${b64}' | base64 -d > /tmp/todo-test.sh && timeout 300 bash /tmp/todo-test.sh; cat /tmp/todo-results.txt`, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = '';
    stream.on('data', (d) => out += d).stderr.on('data', (d) => out += d);
    stream.on('close', () => { console.log(out.trim()); conn.end(); process.exit(0); });
  });
});
conn.connect(loadVmConnection());
