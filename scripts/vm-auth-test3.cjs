const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

const remote = `#!/bin/bash
export PATH=/home/llmx/tools/node/bin:$PATH
BASE=http://127.0.0.1:30141
OUT=/tmp/auth-results.txt
: > $OUT

login_sid() {
  curl -s -m 10 -D /tmp/h.$$ -o /dev/null -X POST $BASE/api/webauth/login -H 'content-type: application/json' -H 'origin: http://127.0.0.1:30141' -d '{"username":"admin","password":"changeme123"}' # secret-scan:allow
  grep -o 'pi_web_sid=[a-f0-9-]*' /tmp/h.$$ | head -1 | cut -d= -f2
}

age() { # sid mode days
python3 - "$1" "$2" "$3" <<'PYEOF'
import json, sys, time
sid, mode, days = sys.argv[1], sys.argv[2], int(sys.argv[3])
p = '/home/llmx/amedac/piweb-data/web-sessions.json'
d = json.load(open(p))
for k, v in d.get('sessions', d).items():
    if isinstance(v, dict) and (k == sid or v.get('sid') == sid):
        if mode == 'absolute':
            v['createdAt'] -= days*24*3600*1000
            v['lastSeenAt'] = int(time.time()*1000)
        else:
            v['lastSeenAt'] = int(time.time()*1000) - days*24*3600*1000
json.dump(d, open(p, 'w'))
PYEOF
}

restart() {
  PID=$(ss -tlnp 2>/dev/null | grep :30141 | grep -oP 'pid=\\K[0-9]+' | head -1)
  [ -n "$PID" ] && kill -9 $PID
  sleep 1
  set -a && . ~/amedac/piweb.env && set +a
  cd ~/amedac/pi-web
  setsid nohup node ./node_modules/next/dist/bin/next start -H 0.0.0.0 -p 30141 > ~/amedac/piweb.log 2>&1 < /dev/null &
  disown
  sleep 9
}

SID=$(login_sid)
echo "sid: \${SID:0:8}" >> $OUT
age "$SID" absolute 91
restart
echo "absolute-91d: $(curl -s -m 10 -o /dev/null -w '%{http_code}' $BASE/api/account -H "cookie: pi_web_sid=$SID") (want 401)" >> $OUT

SID=$(login_sid)
age "$SID" idle 8
restart
echo "idle-8d: $(curl -s -m 10 -o /dev/null -w '%{http_code}' $BASE/api/account -H "cookie: pi_web_sid=$SID") (want 401)" >> $OUT

SID=$(login_sid)
age "$SID" idle 5
restart
echo "idle-5d: $(curl -s -m 10 -o /dev/null -w '%{http_code}' $BASE/api/account -H "cookie: pi_web_sid=$SID") (want 200)" >> $OUT

echo DONE >> $OUT
`;

const b64 = Buffer.from(remote, 'utf8').toString('base64');
conn.on('ready', () => {
  conn.exec(`printf %s '${b64}' | base64 -d > /tmp/auth-test3.sh && timeout 180 bash /tmp/auth-test3.sh; cat /tmp/auth-results.txt`, { pty: false }, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = '';
    stream.on('data', (d) => out += d).stderr.on('data', (d) => out += d);
    stream.on('close', () => { console.log(out.trim()); conn.end(); process.exit(0); });
  });
});
conn.connect(loadVmConnection());
