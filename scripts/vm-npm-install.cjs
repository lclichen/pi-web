const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

const cmd = `
export PATH=/home/llmx/tools/node/bin:$PATH
{
echo "=== npm install ==="
cd ~/amedac/pi-web
npm install > /tmp/npmi.log 2>&1 && echo INSTALL-OK || { echo INSTALL-FAILED; tail -10 /tmp/npmi.log; }
ls node_modules/@types/semver/package.json >/dev/null 2>&1 && echo "types-semver: present" || echo "types-semver: MISSING"
echo "=== rebuild ==="
if npm run build > /tmp/b0909b.log 2>&1; then echo BUILD-OK
  PID=$(ss -tlnp 2>/dev/null | grep ':30141' | grep -oP 'pid=\\K[0-9]+' | head -1)
  [ -n "$PID" ] && kill -9 $PID; sleep 1
  set -a && . ~/amedac/piweb.env && set +a
  setsid nohup node ./node_modules/next/dist/bin/next start -H 0.0.0.0 -p 30141 > ~/amedac/piweb.log 2>&1 < /dev/null &
  sleep 8
  ss -tlnp 2>/dev/null | grep ':30141' | head -1
  curl -s -o /dev/null -w "home: %{http_code}\\n" -m 10 http://127.0.0.1:30141/
  curl -s -o /dev/null -w "templates-api: %{http_code}\\n" -m 10 http://127.0.0.1:30141/api/quick-templates
else echo BUILD-FAILED; tail -15 /tmp/b0909b.log; fi
} > /tmp/deploy0909b.log 2>&1 </dev/null
cat /tmp/deploy0909b.log
exit 0
`;

conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    stream.on('data', d => process.stdout.write(d)).stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
});
conn.connect(loadVmConnection());
