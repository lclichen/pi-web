const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

// 验证新布局：解包 → 用临时 HOME 起服务 → 数据应落在 $HOME/.local/share/amedac
// 而不是包目录内；停止后清理。
const remote = `#!/bin/bash
export PATH=/home/llmx/tools/node/bin:$PATH
OUT=/tmp/pkg-layout-results.txt
: > $OUT
T=/tmp/pkg-layout-test
rm -rf $T && mkdir -p $T/home $T/pkg
tar -xzf /home/llmx/amedac/pi-web/dist/amedac.ai-pi-linux-x64-0.9.0.tar.gz -C $T/pkg --strip-components=1
PKG=$T/pkg/amedac.ai-pi-linux-x64
[ -d "$T/pkg/scripts" ] && PKG=$T/pkg

export HOME=$T/home
export AMEDAC_HOME=$T/home/.local/share/amedac
export PLATFORM_PORT=32100 WEB_PORT=32141
bash $PKG/scripts/start-all.sh > $T/start.log 2>&1
echo "start-exit: $?" >> $OUT
grep -E "就绪|ready|启动" $T/start.log | tail -2 >> $OUT

echo "=== 数据落位检查 ===" >> $OUT
for d in config run logs data; do
  [ -d "$AMEDAC_HOME/$d" ] && echo "HOME/\$d: OK" >> $OUT || echo "HOME/\$d: MISSING" >> $OUT
done
[ -d "$PKG/data" ] && echo "PKG/data: 仍存在（不该）" >> $OUT || echo "PKG/data: 干净 OK" >> $OUT
[ -f "$AMEDAC_HOME/config/platform.env" ] && echo "HOME/config/platform.env: OK" >> $OUT
[ -f "$AMEDAC_HOME/run/ports.env" ] && echo "HOME/run/ports.env: OK" >> $OUT

curl -s -m 5 -o /dev/null -w "web: %{http_code}\\n" http://127.0.0.1:32141/ >> $OUT

echo "=== 迁移幂等：二跑 start-all ===" >> $OUT
bash $PKG/scripts/stop-all.sh >> $T/start.log 2>&1
bash $PKG/scripts/start-all.sh >> $T/start.log 2>&1
echo "second-start-exit: $?" >> $OUT
curl -s -m 5 -o /dev/null -w "web2: %{http_code}\\n" http://127.0.0.1:32141/ >> $OUT

bash $PKG/scripts/stop-all.sh >> $T/start.log 2>&1
echo DONE >> $OUT
`;

const b64 = Buffer.from(remote, 'utf8').toString('base64');
conn.on('ready', () => {
  conn.exec(`printf %s '${b64}' | base64 -d > /tmp/pkg-layout.sh && timeout 240 bash /tmp/pkg-layout.sh; cat /tmp/pkg-layout-results.txt; rm -rf /tmp/pkg-layout-test`, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = '';
    stream.on('data', (d) => out += d).stderr.on('data', (d) => out += d);
    stream.on('close', () => { console.log(out.trim()); conn.end(); process.exit(0); });
  });
});
conn.connect(loadVmConnection());
