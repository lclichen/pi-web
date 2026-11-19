import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_AUTH = "on";
process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "oidc-callback-"));
delete process.env.PI_WEB_PUBLIC_URL;
delete process.env.PI_WEB_PLATFORM_PUBLIC_URL;

// 本地假平台：exchange 成功/失败两个剧本由每个用例切换。
let exchangeStatus = 200;
const platform = createServer((req, res) => {
  if (req.url === "/api/v1/auth/oidc/exchange") {
    res.statusCode = exchangeStatus;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        accessToken: "jwt",
        refreshToken: "r",
        user: { id: 1, username: "u", email: null, role: "user", status: "active" },
      }),
    );
    return;
  }
  if (req.url === "/api/v1/auth/api-keys") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: 7, key: "pk-test" }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

await new Promise((resolve) => platform.listen(0, "127.0.0.1", resolve));
process.env.PI_WEB_PLATFORM_URL = `http://127.0.0.1:${platform.address().port}`;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route.ts");

// 与 begin 路由测试一致：req.url 是内部绑定地址，真实浏览器 origin 由
// 转发头描述；重定向必须基于后者，否则反代后回调会把浏览器带回内网地址。
const callbackRequest = () =>
  new Request("http://0.0.0.0:30141/api/webauth/oidc/callback?code=handoff", {
    headers: {
      host: "0.0.0.0:30141",
      "x-forwarded-host": "pi.example.com",
      "x-forwarded-proto": "https",
    },
  });

test("successful exchange redirects the browser to the forwarded origin and sets the session cookie", async () => {
  exchangeStatus = 200;
  const response = await GET(callbackRequest());
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://pi.example.com/");
  assert.ok(response.headers.get("set-cookie"));
});

test("failed exchange bounces to /login on the forwarded origin with the error code", async () => {
  exchangeStatus = 400;
  const response = await GET(callbackRequest());
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://pi.example.com");
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("error"), "oidc_exchange_failed");
});

test.after(() => platform.close());
