const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

const cmd = `
export PATH=/home/llmx/tools/node/bin:$PATH
{
echo "=== 构建 Electron 桌面包 ==="
cd ~/amedac/pi-web
if bash scripts/package-electron.sh > /tmp/electron-build.log 2>&1; then
  echo ELECTRON-BUILD-OK
  ls -lh dist/amedac.ai-electron-* 2>/dev/null | tail -2
  echo "--- resources/app 内容 ---"
  ls build/package-electron/amedac-electron-x64/resources/app/
  echo "--- bundle pkg-kind ---"
  cat build/package-electron/amedac-electron-x64/resources/app/bundle/pkg-kind 2>/dev/null
  echo "--- electron 可执行 ---"
  ls -la build/package-electron/amedac-electron-x64/electron | head -1
else
  echo ELECTRON-BUILD-FAILED
  tail -25 /tmp/electron-build.log
fi
df -h / | tail -1
} > /tmp/vmelectron.log 2>&1 </dev/null
cat /tmp/vmelectron.log
exit 0
`;

conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    stream.on('data', (d) => process.stdout.write(d)).stderr.on('data', (d) => process.stderr.write(d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
});
conn.connect(loadVmConnection());
