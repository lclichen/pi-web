import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

/**
 * proxy.ts 是所有 /api 路由的匿名门禁。分享下载链接按设计不带 Cookie（token
 * 即凭证），因此 token GET 必须放行；列表/创建/撤销仍须登录。否则 MCP 服务或
 * 另一台设备打开链接只会拿到 401「登录已失效」。
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { proxy } = await jiti.import("../proxy.ts");

const HOST = "127.0.0.1:30141";

function call(method, path) {
  return proxy(new NextRequest(`http://${HOST}${path}`, { method, headers: { host: HOST } }));
}

function passed(res) {
  return res.status === 200 && res.headers.get("x-middleware-next") === "1";
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("auth-on: share token GET is public; management routes stay session-gated", async () => {
  const prevAuth = process.env.PI_WEB_AUTH;
  const prevPassword = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_AUTH = "on";
  delete process.env.PI_WEB_PASSWORD;
  try {
    assert.ok(passed(call("GET", "/api/share/AbCdEfGhIjKlMnOpQrStUv")), "token GET must pass");
    // Bad token shape still reaches the route (answers 404), not a misleading 401.
    assert.ok(passed(call("GET", "/api/share/not-a-token")), "malformed token GET must pass");

    for (const [method, path] of [
      ["GET", "/api/share"],
      ["POST", "/api/share"],
      ["DELETE", "/api/share/AbCdEfGhIjKlMnOpQrStUv"],
    ]) {
      const res = call(method, path);
      assert.equal(res.status, 401, `${method} ${path} must stay gated`);
      assert.deepEqual(await res.json(), { error: "登录已失效" });
    }
  } finally {
    restore("PI_WEB_AUTH", prevAuth);
    restore("PI_WEB_PASSWORD", prevPassword);
  }
});

test("basic-auth mode: share token GET stays public", () => {
  const prevAuth = process.env.PI_WEB_AUTH;
  const prevPassword = process.env.PI_WEB_PASSWORD;
  delete process.env.PI_WEB_AUTH;
  process.env.PI_WEB_PASSWORD = "secret";
  try {
    assert.ok(passed(call("GET", "/api/share/AbCdEfGhIjKlMnOpQrStUv")));
    assert.equal(call("GET", "/api/share").status, 401);
  } finally {
    restore("PI_WEB_AUTH", prevAuth);
    restore("PI_WEB_PASSWORD", prevPassword);
  }
});
