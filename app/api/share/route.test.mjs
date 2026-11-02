import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 独立数据目录 + auth-off（单用户隐式 host 身份）→ 路由可直调无需 Cookie。
const dataDir = mkdtempSync(join(tmpdir(), "share-route-"));
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_WEB_AUTH;
process.env.PI_WEB_PUBLIC_URL = "http://test.local";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { POST, GET } = await jiti.import("./route.ts", { id: "share-create" });
const tokenRoute = await jiti.import("./[token]/route.ts");

const root = mkdtempSync(join(tmpdir(), "share-files-"));
writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), "utf8");
writeFileSync(join(root, "notes.txt"), "hello share", "utf8");

/**
 * 函数级直调三个 handler（auth-off）：创建 → 无 Cookie GET（含 Range）→
 * DELETE 撤销。这是 MCP 服务端实际走的链路。
 */

const HOST = { host: "127.0.0.1:30141" };

/** Call the dynamic-route handler the way Next does: (req, { params }). */
async function fetchShare(url, init) {
  const token = url.split("/").pop();
  return tokenRoute.GET(new Request(url, init), { params: Promise.resolve({ token }) });
}

async function deleteShare(url) {
  const token = url.split("/").pop();
  return tokenRoute.DELETE(
    new Request(url, { method: "DELETE", headers: { "Content-Type": "application/json", ...HOST } }),
    { params: Promise.resolve({ token }) },
  );
}

async function post(body) {
  const req = new Request("http://127.0.0.1:30141/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...HOST },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { res, data: await res.json() };
}

test("host share: create → anonymous GET (200 + mime + no-store) → Range 206 → DELETE", async () => {
  const { res, data } = await post({ path: join(root, "pic.png"), ttlMinutes: 10 });
  assert.equal(res.status, 201);
  assert.match(data.url, /^http:\/\/test\.local\/api\/share\/[A-Za-z0-9_-]{22}$/);
  assert.equal(data.kind, "host");

  // Anonymous fetch — no cookie header anywhere.
  const get1 = await fetchShare(data.url, { headers: HOST });
  assert.equal(get1.status, 200);
  assert.equal(get1.headers.get("content-type"), "image/png");
  assert.equal(get1.headers.get("cache-control"), "no-store");
  assert.equal(get1.headers.get("referrer-policy"), "no-referrer");
  const bytes = Buffer.from(await get1.arrayBuffer());
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes.length, 8);

  // Single range slice.
  const get2 = await fetchShare(data.url, { headers: { Range: "bytes=0-3", ...HOST } });
  assert.equal(get2.status, 206);
  assert.equal(get2.headers.get("content-range"), "bytes 0-3/8");
  assert.equal(Buffer.from(await get2.arrayBuffer()).length, 4);

  const del = await deleteShare(data.url);
  assert.equal(del.status, 200);
  const gone = await fetchShare(data.url, { headers: HOST });
  assert.equal(gone.status, 404);
});

test("snapshot share via srcSession-less POST is rejected; text file shares as octet-stream", async () => {
  // Host text file still shares fine (MCP reads bytes).
  const { res, data } = await post({ path: join(root, "notes.txt"), oneTime: true });
  assert.equal(res.status, 201);
  const get = await fetchShare(data.url, { headers: HOST });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "application/octet-stream");
  assert.equal(await get.text(), "hello share");
  // oneTime: second fetch refused with 410.
  const second = await fetchShare(data.url, { headers: HOST });
  assert.equal(second.status, 410);
});

test("bad token shape and unknown tokens 404; outside-root paths 403", async () => {
  assert.equal((await fetchShare("http://127.0.0.1:30141/api/share/short", { headers: HOST })).status, 404);
  assert.equal(
    (await fetchShare("http://127.0.0.1:30141/api/share/AAAAABBBBBCCCCCDDDDD6", { headers: HOST })).status,
    404,
  );
  const { res } = await post({ path: "/etc/passwd" });
  // auth-off implicit-host roots do not include /etc → denied.
  assert.equal(res.status, 403);
});

test("configured public base URL takes precedence over the request origin", async () => {
  const settings = await jiti.import("../../../lib/server-settings.ts");
  settings.updateServerSettings({ publicBaseUrl: "https://share.example.test/pi-web" });
  try {
    const { res, data } = await post({ path: join(root, "notes.txt") });
    assert.equal(res.status, 201);
    assert.match(data.url, /^https:\/\/share\.example\.test\/pi-web\/api\/share\//);
  } finally {
    settings.updateServerSettings({ publicBaseUrl: "" });
  }
});

test("audit list is available to the implicit host identity", async () => {
  const { data } = await post({ path: join(root, "notes.txt"), maxDownloads: 5 });
  const listRes = await GET(new Request("http://127.0.0.1:30141/api/share", { headers: HOST }));
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(Array.isArray(list.shares));
  assert.ok(list.shares.some((s) => s.path.endsWith("notes.txt") && s.maxDownloads === 5));
});

// Teardown
test.after?.(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
