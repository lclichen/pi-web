const { Client } = require('ssh2');
const conn = new Client();

// Quick-session E2E on the VM:
// 1. login as admin → GET /api/quick-templates (default template seeded)
// 2. create a quick session with the default template
// 3. get_state: verify system prompt is the quick prompt + active tools have NO coding tools
// 4. prompt → model answers without any fs tools
// 5. test user: same flow (permission: any logged-in user)
const cmd = `
export PATH=/home/llmx/tools/node/bin:$PATH
cd ~/amedac/pi-web
node -e '
(async () => {
  const login = async (u, p) => {
    const r = await fetch("http://127.0.0.1:30141/api/webauth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    return (r.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const adminCookie = await login("admin", "changeme123");
  console.log("admin login:", Boolean(adminCookie));

  // 1. templates list
  const tplRes = await fetch("http://127.0.0.1:30141/api/quick-templates", { headers: { Cookie: adminCookie } });
  const tplData = await tplRes.json();
  const def = (tplData.templates ?? []).find((t) => t.id === "default");
  console.log("templates:", tplRes.status, "| default seeded:", Boolean(def), "| count:", (tplData.templates ?? []).length);

  // 2. quick session
  const create = await fetch("http://127.0.0.1:30141/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie, Origin: "http://127.0.0.1:30141" },
    body: JSON.stringify({ mode: "quick", templateId: "default", type: "ensure_session", cwd: "/quick" }),
  }).then((r) => r.json());
  console.log("quick session:", create.sessionId, "| model:", create.model?.modelId);
  if (!create.sessionId) process.exit(1);
  const sid = create.sessionId;
  const H = { "Content-Type": "application/json", Cookie: adminCookie, Origin: "http://127.0.0.1:30141" };

  await new Promise((r) => setTimeout(r, 2500));
  // 3. state: system prompt + tools
  const st = await fetch("http://127.0.0.1:30141/api/agent/" + sid, {
    method: "POST", headers: H, body: JSON.stringify({ type: "get_state" }),
  }).then((r) => r.json());
  const state = st.data ?? st;
  const sp = state.systemPrompt ?? "";
  console.log("quick prompt applied:", sp.includes("快速会话"));
  const toolRes = await fetch("http://127.0.0.1:30141/api/agent/" + sid, {
    method: "POST", headers: H, body: JSON.stringify({ type: "get_tools" }),
  }).then((r) => r.json());
  const tools = (toolRes.data ?? toolRes).tools ?? (toolRes.data ?? toolRes);
  const names = Array.isArray(tools) ? tools.map((t) => t.name ?? t) : [];
  const coding = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].filter((n) => names.includes(n));
  console.log("active tools:", JSON.stringify(names), "| coding leaks:", coding.length);

  // 4. prompt round (no fs tools → model should just answer)
  await fetch("http://127.0.0.1:30141/api/agent/" + sid, {
    method: "POST", headers: H,
    body: JSON.stringify({ type: "prompt", message: "用一句话回答：你现在能读写文件或执行命令吗？只能用文字回答。" }),
  });
  await new Promise((r) => setTimeout(r, 25000));
  const msgs = await fetch("http://127.0.0.1:30141/api/agent/" + sid, {
    method: "POST", headers: H, body: JSON.stringify({ type: "get_state" }),
  }).then((r) => r.json());
  const list = (msgs.data ?? msgs).messages ?? [];
  const lastAssistant = [...list].reverse().find((m) => m.role === "assistant");
  const answerText = lastAssistant ? JSON.stringify(lastAssistant.content).slice(0, 160) : "(none)";
  console.log("answer:", answerText);

  // 5. test user permission
  const testCookie = await login("test", "test1234");
  const testCreate = await fetch("http://127.0.0.1:30141/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: testCookie, Origin: "http://127.0.0.1:30141" },
    body: JSON.stringify({ mode: "quick", type: "ensure_session", cwd: "/quick" }),
  }).then((r) => r.json());
  console.log("test-user quick session:", testCreate.sessionId ? "OK" : ("FAIL: " + (testCreate.error ?? "")));
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
'
exit 0
`;

conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    stream.on('data', d => process.stdout.write(d)).stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
});
conn.connect({ host: '10.99.9.7', username: 'llmx', password: 'llmx112358X' });
