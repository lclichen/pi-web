import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { isLoopbackHost, readInitialPassword, consumeInitialPasswordIfMatch } = await jiti.import("../../../../lib/initial-password.ts");

const SAVED_FILE = process.env.PI_WEB_INITIAL_PASSWORD_FILE;

function withPasswordFile(t, content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-web-firstrun-"));
  const file = path.join(dir, "admin-password.txt");
  writeFileSync(file, content, "utf8");
  process.env.PI_WEB_INITIAL_PASSWORD_FILE = file;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (SAVED_FILE === undefined) delete process.env.PI_WEB_INITIAL_PASSWORD_FILE;
    else process.env.PI_WEB_INITIAL_PASSWORD_FILE = SAVED_FILE;
  });
  return file;
}

function requestFor(host) {
  return new Request("http://x/api/webauth/first-run", { headers: { host } });
}

test("isLoopbackHost accepts only loopback hostnames", () => {
  assert.equal(isLoopbackHost(requestFor("127.0.0.1:30141")), true);
  assert.equal(isLoopbackHost(requestFor("localhost:30141")), true);
  assert.equal(isLoopbackHost(requestFor("[::1]:30141")), true);
  assert.equal(isLoopbackHost(requestFor("10.99.9.7:30141")), false);
  assert.equal(isLoopbackHost(requestFor("ide.example.com")), false);
});

test("readInitialPassword reads the first line only", (t) => {
  withPasswordFile(t, "pw-line-1\npw-line-2\n");
  assert.equal(readInitialPassword(), "pw-line-1");
});

test("consumeInitialPasswordIfMatch deletes only on exact match", (t) => {
  const file = withPasswordFile(t, "initial-pw");
  assert.equal(consumeInitialPasswordIfMatch("wrong"), false);
  assert.equal(readInitialPassword(), "initial-pw"); // 未删
  assert.equal(consumeInitialPasswordIfMatch("initial-pw"), true);
  assert.equal(readInitialPassword(), null); // 文件已删（窗口关闭）
});

test("first-run: no password file → needed=false", async () => {
  delete process.env.PI_WEB_INITIAL_PASSWORD_FILE;
  const res = await GET(requestFor("127.0.0.1:30141"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { needed: false });
});

// 本地 mock 平台：任意 /auth/login POST → 200 {}（让探测通过）。
async function withMockPlatform(t) {
  const SAVED_URL = process.env.PI_WEB_PLATFORM_URL;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  process.env.PI_WEB_PLATFORM_URL = `http://127.0.0.1:${port}`;
  t.after(() => {
    server.close();
    if (SAVED_URL === undefined) delete process.env.PI_WEB_PLATFORM_URL;
    else process.env.PI_WEB_PLATFORM_URL = SAVED_URL;
  });
}

test("first-run: loopback host gets username+password after platform probe passes", async (t) => {
  await withMockPlatform(t);
  withPasswordFile(t, "loopback-pw");
  const res = await GET(requestFor("127.0.0.1:30141"));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.needed, true);
  assert.equal(d.username, "admin");
  assert.equal(d.password, "loopback-pw");
});

test("first-run: non-loopback host gets only the hint, never the password", async (t) => {
  await withMockPlatform(t);
  withPasswordFile(t, "secret-pw");
  const res = await GET(requestFor("10.99.9.7:30141"));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.needed, true);
  assert.equal(d.password, undefined);
  assert.match(d.hint ?? "", /127\.0\.0\.1/);
});

test("first-run: IPv6 loopback [::1] also reveals the password", async (t) => {
  await withMockPlatform(t);
  withPasswordFile(t, "v6-pw");
  const res = await GET(requestFor("[::1]:30141"));
  const d = await res.json();
  assert.equal(d.password, "v6-pw");
});

test("first-run: stale file (platform rejects the password) → needed=false", async (t) => {
  // 平台不可达（源码部署无 PI_WEB_PLATFORM_URL）→ 探测失败按已消费处理。
  delete process.env.PI_WEB_PLATFORM_URL;
  withPasswordFile(t, "stale-pw");
  const res = await GET(requestFor("127.0.0.1:30141"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { needed: false });
});
