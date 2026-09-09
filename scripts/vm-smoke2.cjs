const { Client } = require('ssh2');
const conn = new Client();
const cmd = `
export PATH=/home/llmx/tools/node/bin:$PATH
cd ~/amedac/pi-web
node -e '
(async () => {
  const r0 = await fetch("http://127.0.0.1:30141/api/webauth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "changeme123" }),
  });
  const cookie = (r0.headers.get("set-cookie") ?? "").split(";")[0];
  const res = await fetch("http://127.0.0.1:30141/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://127.0.0.1:30141" },
    body: JSON.stringify({ mode: "quick", templateId: "default", type: "ensure_session", cwd: "/quick" }),
  });
  console.log("HTTP", res.status);
  console.log((await res.text()).slice(0, 400));
})().catch((e) => console.error(e.message));
'
exit 0
`;
conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    stream.on('data', d => process.stdout.write(d)).stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
});
conn.connect({ host: '10.99.9.7', username: 'llmx', password: 'llmx112358X' });
