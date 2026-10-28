/**
 * API 权限探针（只读审计）：对全部路由用「匿名」与「普通用户」两种身份
 * 各发一次最小请求（GET 原样；写方法发空 JSON；动态段用哑 id），记录
 * 状态码。判定规则：
 *   - 匿名 200 = 疑似未鉴权（需人工复核语义）
 *   - 普通用户 200 于管理面 = 越权疑点
 *   - 4xx/5xx（含 400 参数错）= 有门控在前，符合预期
 * 有副作用的写方法用空 JSON 探测——设计良好的路由会先拒绝身份/参数。
 */
const BASE = "http://127.0.0.1:30141";
const fs = require("fs");
const path = require("path");

// 略过实测的路由（副作用危险 / 本身就是匿名端点 / 长连接）
const SKIP = new Set([
  "webauth/login",
  "webauth/register",
  "webauth/logout",
  "webauth/first-run",
  "webauth/touch",
  "webauth/me",
  "webauth/config",
  "auth/login/[provider]",
  "auth/logout/[provider]",
  "app-update/apply",
  "app-update",
  "app-update/status",
  "agent/new",
  "agent/[id]/events",
  "agent-relay/rpc/stream",
  "agent-relay/status/events",
  "push/subscribe",
  "terminal/[sid]/events",
  "remoteterminal/[sid]/events",
  "agent-relay/terminal/[sid]/events",
  "skills/install",
  "host/config-import",
  "sessions/[id]/export", // 大响应
]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

async function probe(url, method, cookie) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(method !== "GET" ? { body: "{}" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    // SSE 等长响应立即中断
    try {
      await res.text();
    } catch {
      /* aborted body */
    }
    return res.status;
  } catch (e) {
    return e.name === "TimeoutError" || e.name === "AbortError"
      ? "timeout"
      : String(e.cause?.code ?? e.message).slice(0, 24);
  }
}

(async () => {
  // 普通用户会话：凭据经环境变量注入（API_AUDIT_USER / API_AUDIT_PASSWORD），
  // 或复用已有 cookie 文件（API_AUDIT_COOKIE_FILE，内容为 "pi_web_sid=…"）。
  let userCookie =
    process.env.API_AUDIT_COOKIE ??
    (process.env.API_AUDIT_COOKIE_FILE ? fs.readFileSync(process.env.API_AUDIT_COOKIE_FILE, "utf8").trim() : null);
  if (!userCookie) {
    if (!process.env.API_AUDIT_USER || !process.env.API_AUDIT_PASSWORD) {
      console.error("需要 API_AUDIT_USER + API_AUDIT_PASSWORD（或 API_AUDIT_COOKIE(_FILE)）");
      process.exit(2);
    }
    const login = await fetch(`${BASE}/api/webauth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: process.env.API_AUDIT_USER, password: process.env.API_AUDIT_PASSWORD }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    userCookie = setCookie.split(";")[0];
    console.error("user login:", login.status, userCookie ? "ok" : "FAIL");
  }

  const routes = walk("app/api").sort();
  const results = [];
  for (const f of routes) {
    const api = f.split(path.sep).join("/").replace("app/api/", "").replace("/route.ts", "");
    if (SKIP.has(api)) continue;
    const s = fs.readFileSync(f, "utf8");
    const methods = [...s.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map((m) => m[1]);
    for (const m of methods) {
      // 动态段填哑值
      const url = `${BASE}/api/${api
        .replace(/\[id\]/g, "x")
        .replace(/\[name\]/g, "x")
        .replace(/\[machineId\]/g, "x")
        .replace(/\[userId\]/g, "999999")
        .replace(/\[provider\]/g, "x")
        .replace(/\[sid\]/g, "x")
        .replace(/\[templateId\]/g, "x")
        .replace(/\[entryId\]/g, "x")
        .replace(/\[\.\.\..*\]/g, "x")}`;
      const anon = await probe(url, m, null);
      const authed = await probe(url, m, userCookie);
      results.push({ api, method: m, anon, authed });
    }
  }
  for (const r of results) console.log(`${r.api}\t${r.method}\t${r.anon}\t${r.authed}`);
  console.error("probed", results.length, "endpoints");
})();
