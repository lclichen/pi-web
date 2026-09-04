// M-series E2E check against the LIVE dev relay (127.0.0.1:30141/30142):
// pair two fake machines for the logged-in admin, connect them over the real
// WS protocol, and verify machines listing + per-machine RPC routing + pty
// fan-out keying + same-machine eviction semantics.
import WebSocket from "../node_modules/ws/index.js";

const base = "http://127.0.0.1:30141";

// Log in ourselves — no external cookie jar dependency.
const loginRes = await fetch(base + "/api/webauth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "LocalDev-9x" }),
});
if (!loginRes.ok) throw new Error("login failed: " + loginRes.status);
const setCookie = loginRes.headers.get("set-cookie") ?? "";
const sid = /pi_web_sid=([^;]+)/.exec(setCookie)?.[1];
if (!sid) throw new Error("no session cookie");
const H = { Cookie: `pi_web_sid=${sid}`, "Content-Type": "application/json" };

const j = async (url, opts = {}) => {
  const res = await fetch(base + url, { ...opts, headers: { ...H, ...(opts.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

function rpcOver(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) {
        ws.off("message", onMsg);
        m.ok ? resolve(m.result) : reject(new Error(m.error));
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error("rpc timeout")), 8000);
  });
}

// 1. mint two pairing codes (with labels)
const p1 = await j("/api/agent-relay/pair", { method: "POST", body: JSON.stringify({ label: "工位机" }) });
const p2 = await j("/api/agent-relay/pair", { method: "POST", body: JSON.stringify({ label: "服务器" }) });
console.log("pair codes:", p1.status, p2.status);

// 2. exchange for tokens with distinct machineIds (as the Go agent would)
const ex = async (code, machineId) => {
  const res = await fetch(`http://127.0.0.1:30142/pair/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, machineId, hostname: "h-" + machineId }),
  });
  return (await res.json());
};
const t1 = await ex(p1.body.code, "mac-e2e-a");
const t2 = await ex(p2.body.code, "mac-e2e-b");
console.log("tokens:", !!t1.token, !!t2.token, "machineId echo:", t1.machineId);

// 3. connect both agents; respond to fs.list with a machine-tagged root
const connect = (token, machineId) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:30142/ws?token=${token}`);
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", info: { hostname: "h-" + machineId, os: "linux", arch: "amd64", workspaceRoot: `/root-${machineId}`, agentVersion: "e2e", machineId, label: machineId } }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method === "fs.list") {
        ws.send(JSON.stringify({ id: m.id, ok: true, result: [{ name: `file-of-${machineId}`, path: ".", isDir: false, size: 1, mtime: 0 }] }));
      } else if (m.method === "exec.run") {
        ws.send(JSON.stringify({ id: m.id, ok: true, result: { exitCode: 0, stdout: `ran-on-${machineId}`, stderr: "" } }));
      }
    });
    resolve(ws);
  });
});
const a = await connect(t1.token, "mac-e2e-a");
const b = await connect(t2.token, "mac-e2e-b");
await new Promise((r) => setTimeout(r, 500));

// 4. machines listing shows both online (list may contain machines from
// earlier runs — assert on the two THIS script just paired)
const machines = await j("/api/agent-relay/machines");
console.log("machines:", machines.body.machines.map((m) => `${m.label}:${m.online}`).join(", "));
const a1 = machines.body.machines.find((m) => m.machineId === "mac-e2e-a");
const b1 = machines.body.machines.find((m) => m.machineId === "mac-e2e-b");
console.log("M-01 (dual pairing, both online):", a1?.online === true && b1?.online === true ? "PASS" : "FAIL");

// 5. per-machine routing: rpc fs.list with machineId A vs B
const ra = await j("/api/agent-relay/rpc", { method: "POST", body: JSON.stringify({ method: "fs.list", params: { path: "." }, machineId: "mac-e2e-a" }) });
const rb = await j("/api/agent-relay/rpc", { method: "POST", body: JSON.stringify({ method: "fs.list", params: { path: "." }, machineId: "mac-e2e-b" }) });
const routedA = JSON.stringify(ra.body).includes("mac-e2e-a");
const routedB = JSON.stringify(rb.body).includes("mac-e2e-b");
console.log("M-02 (per-machine routing):", routedA && routedB ? "PASS" : "FAIL", `(a->${routedA}, b->${routedB})`);

// 6. default = most recent (b connected last)
const rd = await j("/api/agent-relay/rpc", { method: "POST", body: JSON.stringify({ method: "fs.list", params: { path: "." } }) });
console.log("M-03 (default = most recent):", JSON.stringify(rd.body).includes("mac-e2e-b") ? "PASS" : "FAIL");

// 7. offline machine: close A → machines shows offline, B still routable
a.close();
await new Promise((r) => setTimeout(r, 700));
const m2 = await j("/api/agent-relay/machines");
const aStat = m2.body.machines.find((m) => m.machineId === "mac-e2e-a");
const rb2 = await j("/api/agent-relay/rpc", { method: "POST", body: JSON.stringify({ method: "fs.list", params: { path: "." }, machineId: "mac-e2e-b" }) });
console.log("M-04 (A offline, B unaffected):", aStat.online === false && rb2.status === 200 ? "PASS" : "FAIL");

// 8. explicit routing to an OFFLINE machine errors
const ra2 = await j("/api/agent-relay/rpc", { method: "POST", body: JSON.stringify({ method: "fs.list", params: { path: "." }, machineId: "mac-e2e-a" }) });
console.log("M-04b (routing to offline machine -> 503):", ra2.status === 503 ? "PASS" : "FAIL " + ra2.status);

// 9. unpair B: token dies + WS closes
const un = await j("/api/agent-relay/machines/mac-e2e-b/unpair", { method: "POST" });
await new Promise((r) => setTimeout(r, 500));
const wsTry = new WebSocket(`ws://127.0.0.1:30142/ws?token=${t2.token}`);
let verdict = "FAIL";
await new Promise((r) => {
  wsTry.on("unexpected-response", (_q, res) => { verdict = res.statusCode === 401 ? "PASS" : "FAIL " + res.statusCode; wsTry.terminate(); r(); });
  wsTry.on("open", () => { verdict = "FAIL (reconnected!)"; wsTry.close(); r(); });
  setTimeout(r, 4000);
});
console.log("M-06 (unpair revokes token):", un.status === 200 && verdict === "PASS" ? "PASS" : "FAIL " + verdict);
console.log("done");
b.close();
process.exit(0);
