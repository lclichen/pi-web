/**
 * Sandbox platform /tools/manifest 真机 E2E（在 VM 上对真实 Apptainer 容器执行）。
 *
 * 覆盖：注册/登录 → 创建一次性容器 → 写入投影文件 → POST tools/manifest
 *   → 断言路径/大小/mtime、跳过 .git 与 node_modules/.cache → 销毁容器。
 *
 * 前置：平台 REGISTER_MODE=open（VM 测试环境默认），EXECUTOR_KIND=apptainer-cli/ssh。
 * 运行（VM）：cd ~/amedac/pi-web && PLATFORM_BASE=http://127.0.0.1:3000/api/v1 \
 *   node --experimental-strip-types e2e/platform-manifest-real.mjs
 */
import assert from "node:assert/strict";

const base = process.env.PLATFORM_BASE ?? "http://127.0.0.1:3000/api/v1";
const username = `manifest${Date.now()}`;
// Randomized per run so the scanner never sees a static test credential.
const password = `ManifestE2e${Date.now()}aA1`;

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

let token = "";
let containerId = 0;
try {
  await call("/auth/register", { method: "POST", body: { username, password } });
  const login = await call("/auth/login", { method: "POST", body: { username, password } });
  token = login.accessToken;
  assert.ok(token, "login returned an access token");

  const images = await call("/images", { token });
  assert.ok(images.images?.length > 0, "a public image is available");
  const created = await call("/containers", {
    method: "POST",
    token,
    body: { imageId: images.images[0].id, name: `manifest-e2e-${Date.now()}` },
  });
  containerId = created.id;
  assert.ok(containerId > 0, "container created");

  const files = {
    "/workspace/.pi/skills/demo/SKILL.md": "# demo",
    "/workspace/.pi/skills/demo/scripts/run.sh": "echo hi",
    "/workspace/.pi/skills/demo/.git/config": "noise",
    "/workspace/.pi/skills/demo/node_modules/.cache/a.js": "noise",
    "/workspace/.pi/attachments/pic.bin": Buffer.from([1, 2, 3]),
  };
  for (const [path, content] of Object.entries(files)) {
    await call(`/containers/${containerId}/tools/write`, {
      method: "POST",
      token,
      body: { path, content: (Buffer.isBuffer(content) ? content : Buffer.from(content)).toString("base64") },
    });
  }

  const manifest = await call(`/containers/${containerId}/tools/manifest`, {
    method: "POST",
    token,
    body: { roots: ["/workspace/.pi/skills", "/workspace/.pi/attachments", "/workspace/.pi/missing"] },
  });
  assert.equal(manifest.truncated, false);
  assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), [
    "/workspace/.pi/attachments/pic.bin",
    "/workspace/.pi/skills/demo/SKILL.md",
    "/workspace/.pi/skills/demo/scripts/run.sh",
  ]);
  for (const entry of manifest.entries) {
    assert.ok(entry.size > 0 && entry.mtimeMs > 0);
  }
  console.log("PASS: platform tools/manifest over real executor");
} finally {
  if (containerId) {
    await call(`/containers/${containerId}`, { method: "DELETE", token }).catch(() => {});
  }
}
