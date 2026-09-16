const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

// catalog 自更新 E2E：
//  1) 把构建出的 tar 包装到 ~/amedac/app-test，伪造更旧版本（0.0.0-alpha）
//  2) 准备本地文件 catalog（0.0.1-alpha → 同一个 tar 包 + 真实 sha256）
//  3) 独立端口起服务（32100/32141，AMEDAC_HOME 独立）
//  4) 登录 → GET /api/app-update（期望 updateAvailable）→ POST apply → 轮询 status
//  5) 验证：版本变新、admin 密码不变（数据回迁成功）
const cmd = `
export PATH=/home/llmx/tools/node/bin:$PATH
{
set -x
BASE=~/amedac
APP=$BASE/app-test
HOME_DIR=$BASE/update-home
SRC=$BASE/update-src
TARBALL=$BASE/pi-web/dist/amedac.ai-pi-linux-x64-0.9.0.tar.gz

echo "=== 清理旧测试现场 ==="
bash $APP/scripts/stop-all.sh >/dev/null 2>&1 || true
rm -rf $APP $HOME_DIR $SRC

echo "=== 1. 安装目标版本（伪造旧版 0.0.0-alpha）==="
mkdir -p $APP $HOME_DIR $SRC
tar -xzf $TARBALL -C $APP --strip-components=1
echo '{"project":"amedac.ai-agent-framework","version":"0.0.0-alpha","channel":"alpha"}' > $APP/version.json
cp $APP/version.json $APP/app/version.json

echo "=== 2. 准备 catalog ==="
mkdir -p $SRC/releases/0.0.1-alpha/tarball
cp $TARBALL $SRC/releases/0.0.1-alpha/tarball/amedac.ai-x64.tar.gz
SHA=$(sha256sum $SRC/releases/0.0.1-alpha/tarball/amedac.ai-x64.tar.gz | cut -d' ' -f1)
SIZE=$(stat -c%s $SRC/releases/0.0.1-alpha/tarball/amedac.ai-x64.tar.gz)
cat > $SRC/catalog.json <<EOF
{
  "schema_version": 1,
  "project": "amedac.ai-agent-framework",
  "default_version": "0.0.1-alpha",
  "latest_versions": { "alpha": "0.0.1-alpha" },
  "versions": [{
    "version": "0.0.1-alpha",
    "channel": "alpha",
    "released_at": "2026-09-15T00:00:00Z",
    "release_dir": "releases/0.0.1-alpha",
    "frameworks": {
      "tarball": {
        "file_name": "amedac.ai-x64.tar.gz",
        "relative_path": "releases/0.0.1-alpha/tarball/amedac.ai-x64.tar.gz",
        "checksum_sha256": "$SHA",
        "size_bytes": $SIZE
      }
    }
  }]
}
EOF
echo "catalog sha: $SHA"

echo "=== 3. 启动被测实例（32100/32141）==="
export AMEDAC_HOME=$HOME_DIR
export AMEDAC_UPDATE_CATALOG_URL=$SRC/catalog.json
export PLATFORM_PORT=32100 WEB_PORT=32141
# 注意：AMEDAC_CONFIG_DIR 等不导出——数据落包内，正好验证交换后的回迁路径。
bash $APP/scripts/start-all.sh > /tmp/e2e-start.log 2>&1
tail -5 /tmp/e2e-start.log
curl -s -o /dev/null -w "web-before: %{http_code}\\n" -m 5 http://127.0.0.1:32141/ || true

ADMIN_PW=$(cat $APP/config/admin-password.txt)
echo "=== 4. 登录 + 检查更新 ==="
COOKIE=$(curl -s -c - -X POST http://127.0.0.1:32141/api/webauth/login -H "content-type: application/json" -H "origin: http://127.0.0.1:32141" -H "host: 127.0.0.1:32141" -d "{\\"username\\":\\"admin\\",\\"password\\":\\"$ADMIN_PW\\"}" | grep pi_web_sid | awk '{print $7}')
echo "cookie-len: \${#COOKIE}"
curl -s -H "host: 127.0.0.1:32141" -H "cookie: pi_web_sid=$COOKIE" http://127.0.0.1:32141/api/app-update | head -c 500; echo

echo "=== 5. 应用更新 ==="
curl -s -X POST http://127.0.0.1:32141/api/app-update/apply -H "content-type: application/json" -H "origin: http://127.0.0.1:32141" -H "host: 127.0.0.1:32141" -H "cookie: pi_web_sid=$COOKIE" -d '{}'; echo

echo "=== 6. 轮询状态 ==="
for i in $(seq 1 120); do
  S=$(curl -s -m 2 -H "cookie: pi_web_sid=$COOKIE" http://127.0.0.1:32141/api/app-update/status 2>/dev/null || echo '{"phase":"(server-down)"}')
  PHASE=$(echo $S | grep -o '"phase":"[^"]*"' | head -1)
  echo "[$i] $PHASE"
  case "$PHASE" in *done*|*failed*) echo "FINAL: $S"; break;; esac
  sleep 5
done

echo "=== 7. 验证新版本 ==="
sleep 5
for i in $(seq 1 12); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://127.0.0.1:32141/ 2>/dev/null || echo 000)
  [ "$CODE" = "307" ] || [ "$CODE" = "200" ] && break
  sleep 5
done
curl -s -o /dev/null -w "web-after: %{http_code}\\n" -m 5 http://127.0.0.1:32141/ || true
echo "version.json after: $(cat $APP/version.json 2>/dev/null)"
ls $APP.bak-* -d 2>/dev/null && echo "（旧根保留为 .bak，run/logs/config/data 应已回迁）"
ls $APP/run $APP/config >/dev/null 2>&1 && echo "数据目录回迁: OK"
# 数据保留验证：同一管理员密码仍能登录
COOKIE2=$(curl -s -c - -X POST http://127.0.0.1:32141/api/webauth/login -H "content-type: application/json" -H "origin: http://127.0.0.1:32141" -H "host: 127.0.0.1:32141" -d "{\\"username\\":\\"admin\\",\\"password\\":\\"$ADMIN_PW\\"}" | grep pi_web_sid | awk '{print $7}')
echo "cookie2-len: \${#COOKIE2}"
curl -s -H "cookie: pi_web_sid=$COOKIE2" http://127.0.0.1:32141/api/app-update | head -c 300; echo
} > /tmp/e2e-update.log 2>&1 </dev/null
cat /tmp/e2e-update.log
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
