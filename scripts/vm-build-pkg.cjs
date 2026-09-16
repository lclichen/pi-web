const { Client } = require('ssh2');
const { loadVmConnection } = require('./vm-connection.cjs');
const conn = new Client();

// 在 VM 上同步 dev 分支并构建 tar 分发包（跳过内置冒烟，后续用 catalog E2E 真实验证）。
const cmd = `
export PATH=/home/llmx/tools/node/bin:$PATH
{
echo "=== 磁盘清理 ==="
cd ~/amedac/pi-web
rm -rf build/package-linux build/package-electron .next/cache/fetch-cache 2>/dev/null
npm cache clean --force >/dev/null 2>&1 || true
rm -rf /tmp/appimage_extracted_* 2>/dev/null || true
df -h / | tail -1
echo "=== 同步 dev ==="
git fetch origin dev 2>&1 | tail -1
git reset --hard origin/dev 2>&1 | tail -1
git log --oneline -1
echo "=== 构建分发包 ==="
if SMOKE_TEST=0 bash scripts/package-linux.sh > /tmp/pkg-build.log 2>&1; then
  echo BUILD-OK
  ls -lh dist/*.tar.gz | tail -2
  cat build/package-linux/amedac.ai-pi-linux-x64/version.json
  cat build/package-linux/amedac.ai-pi-linux-x64/pkg-kind
  ls build/package-linux/amedac.ai-pi-linux-x64/scripts/apply-update.cjs && echo APPLIER-PRESENT
  ls build/package-linux/amedac.ai-pi-linux-x64/app/version.json && echo APP-VERSION-PRESENT
else
  echo BUILD-FAILED; tail -25 /tmp/pkg-build.log
fi
} > /tmp/vmbuild.log 2>&1 </dev/null
cat /tmp/vmbuild.log
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
