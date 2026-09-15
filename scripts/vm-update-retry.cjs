const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

// 失败重试路径的 E2E：重置状态 → 再次 apply → 轮询 → 验证。
// applier 的同步走 fastPut（open+write 不截断会留 0 字节文件——踩过的坑）。
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error(err); process.exit(1); }
    sftp.fastPut(require('path').join(__dirname, '../packaging/scripts/apply-update.cjs'), '/home/llmx/amedac/app-test/scripts/apply-update.cjs', (e) => {
      if (e) { console.error('fastPut: ' + e.message); process.exit(1); }
      console.log('applier 已同步到被测实例');
      conn.exec(`
export PATH=/home/llmx/tools/node/bin:$PATH
{
set -x
APP=~/amedac/app-test
rm -rf $APP/data/piweb/update-staging
echo '{"phase":"idle"}' > $APP/data/piweb/update-status.json
ADMIN_PW=$(cat $APP/config/admin-password.txt)
COOKIE=$(curl -s -c - -X POST http://127.0.0.1:32141/api/webauth/login -H "content-type: application/json" -H "origin: http://127.0.0.1:32141" -H "host: 127.0.0.1:32141" -d "{\\"username\\":\\"admin\\",\\"password\\":\\"$ADMIN_PW\\"}" | grep pi_web_sid | awk '{print $7}')
echo "cookie-len: \${#COOKIE}"
echo "--- 检查（应提示可更新）---"
curl -s -H "cookie: pi_web_sid=$COOKIE" http://127.0.0.1:32141/api/app-update | head -c 400; echo
echo "--- 再次 apply ---"
curl -s -X POST http://127.0.0.1:32141/api/app-update/apply -H "content-type: application/json" -H "origin: http://127.0.0.1:32141" -H "host: 127.0.0.1:32141" -H "cookie: pi_web_sid=$COOKIE" -d '{}'; echo
echo "--- 轮询 ---"
for i in $(seq 1 90); do
  S=$(curl -s -m 2 -H "cookie: pi_web_sid=$COOKIE" http://127.0.0.1:32141/api/app-update/status 2>/dev/null || echo '{"phase":"(down)"}')
  PHASE=$(echo $S | grep -o '"phase":"[^"]*"' | head -1)
  echo "[$i] $PHASE"
  case "$PHASE" in *done*|*failed*) echo "FINAL: $S"; break;; esac
  sleep 5
done
echo "--- 验证 ---"
sleep 8
for i in $(seq 1 12); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://127.0.0.1:32141/ 2>/dev/null || echo 000)
  { [ "$CODE" = "307" ] || [ "$CODE" = "200" ]; } && break
  sleep 5
done
curl -s -o /dev/null -w "web-after: %{http_code}\\n" -m 5 http://127.0.0.1:32141/ || true
echo "version: $(cat $APP/version.json 2>/dev/null)"
ls -d $APP.bak-* 2>/dev/null | head -2
ls $APP/run $APP/config >/dev/null 2>&1 && echo "数据回迁: OK"
du -sh $APP/data/piweb/update-staging 2>/dev/null || echo "staging 已清理: OK"
COOKIE2=$(curl -s -c - -X POST http://127.0.0.1:32141/api/webauth/login -H "content-type: application/json" -H "origin: http://127.0.0.1:32141" -H "host: 127.0.0.1:32141" -d "{\\"username\\":\\"admin\\",\\"password\\":\\"$ADMIN_PW\\"}" | grep pi_web_sid | awk '{print $7}')
echo "cookie2-len: \${#COOKIE2}"
curl -s -H "cookie: pi_web_sid=$COOKIE2" http://127.0.0.1:32141/api/app-update | head -c 300; echo
} > /tmp/e2e-retry.log 2>&1 </dev/null
cat /tmp/e2e-retry.log
exit 0
`, (err4, stream) => {
        if (err4) { console.error(err4); process.exit(1); }
        stream.on('data', d => process.stdout.write(d)).stderr.on('data', d => process.stderr.write(d));
        stream.on('close', () => { conn.end(); process.exit(0); });
      });
    });
  });
});
conn.connect(loadVmConnection());
