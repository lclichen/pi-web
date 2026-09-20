const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

// VM 是源码部署：手动造一个与平台一致的密码文件 + 注入 env 重启，验证三态
const remote = `#!/bin/bash
export PATH=/home/llmx/tools/node/bin:$PATH
BASE=http://127.0.0.1:30141
OUT=/tmp/firstrun-vm.txt
: > $OUT

PWFILE=/home/llmx/amedac/update-test-password.txt
echo PLACEHOLDER > $PWFILE   # 与平台 admin 当前密码一致，模拟首启窗口 # secret-scan:allow

restart() {
  PID=$(ss -tlnp 2>/dev/null | grep :30141 | grep -oP 'pid=\\K[0-9]+' | head -1)
  [ -n "$PID" ] && kill -9 $PID
  sleep 1
  set -a && . ~/amedac/piweb.env && set +a
  export PI_WEB_INITIAL_PASSWORD_FILE=$PWFILE
  cd ~/amedac/pi-web
  setsid nohup node ./node_modules/next/dist/bin/next start -H 0.0.0.0 -p 30141 > ~/amedac/piweb.log 2>&1 < /dev/null &
  disown
  sleep 9
}

restart

echo '=== [1] 回环 Host → 应显示 admin/PLACEHOLDER ===' >> $OUT
curl -s -m 10 $BASE/api/webauth/first-run -H 'host: 127.0.0.1:30141' >> $OUT
echo '' >> $OUT

echo '=== [2] 远程 Host → 只给提示不给密码 ===' >> $OUT
curl -s -m 10 $BASE/api/webauth/first-run -H 'host: 10.99.9.7:30141' >> $OUT
echo '' >> $OUT

echo '=== [3] 用初始密码登录 → usedInitialPassword=true 且文件被删 ===' >> $OUT
curl -s -m 10 -X POST $BASE/api/webauth/login -H 'content-type: application/json' -H 'origin: http://127.0.0.1:30141' -H 'host: 127.0.0.1:30141' -d '{"username":"admin","password":"PLACEHOLDER"}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("usedInitialPassword:", d.get("usedInitialPassword"), "| user:", (d.get("user") or {}).get("username"))' >> $OUT
[ -f $PWFILE ] && echo "file: 仍存在（异常）" >> $OUT || echo "file: 已删除 OK" >> $OUT

echo '=== [4] 文件删除后再查 first-run → needed=false ===' >> $OUT
curl -s -m 10 $BASE/api/webauth/first-run -H 'host: 127.0.0.1:30141' >> $OUT
echo '' >> $OUT

echo '=== [5] 恢复：去掉 env 重启回正常部署 ===' >> $OUT
PID=$(ss -tlnp 2>/dev/null | grep :30141 | grep -oP 'pid=\\K[0-9]+' | head -1)
[ -n "$PID" ] && kill -9 $PID
sleep 1
set -a && . ~/amedac/piweb.env && set +a
cd ~/amedac/pi-web
setsid nohup node ./node_modules/next/dist/bin/next start -H 0.0.0.0 -p 30141 > ~/amedac/piweb.log 2>&1 < /dev/null &
disown
sleep 9
curl -s -o /dev/null -w "restored web: %{http_code}\\n" -m 10 $BASE/ >> $OUT
rm -f $PWFILE
echo DONE >> $OUT
`;

const b64 = Buffer.from(remote, 'utf8').toString('base64');
conn.on('ready', () => {
  conn.exec(`printf %s '${b64}' | base64 -d > /tmp/firstrun-vm.sh && timeout 180 bash /tmp/firstrun-vm.sh; cat /tmp/firstrun-vm.txt`, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = '';
    stream.on('data', (d) => out += d).stderr.on('data', (d) => out += d);
    stream.on('close', () => { console.log(out.trim()); conn.end(); process.exit(0); });
  });
});
conn.connect(loadVmConnection());
