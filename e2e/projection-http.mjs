/**
 * 工作区投影 HTTP E2E（在 VM 本机执行）：真实 Next 路由 + 真实 SSH 通道。
 *
 * 覆盖：登录 → 创建 SSH 项目 → 项目区写 skill → POST /projection/repair
 *   → GET /projection 状态 → 远端篡改后按路径强制回灌 → DELETE 项目清理。
 *
 * 前置：VM 已部署、qa_loopback 公钥已写入 authorized_keys、
 *   scripts/vm-credentials.cjs 可用（或设置 VM_APP_ADMIN_PASSWORD）。
 * 运行（VM）：cd ~/amedac/pi-web && node --experimental-strip-types e2e/projection-http.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const base = process.env.PI_WEB_BASE ?? "http://127.0.0.1:30141";
const dataDir = process.env.PI_WEB_DATA_DIR ?? "/home/llmx/amedac/piweb-data";
const require = createRequire(import.meta.url);
const creds = require("../scripts/vm-credentials.cjs");
const username = process.env.VM_APP_ADMIN_USER ?? "admin";
const password = process.env.VM_APP_ADMIN_PASSWORD ?? creds.appAccounts?.[username];
if (!password) throw new Error("缺少 admin 密码（VM_APP_ADMIN_PASSWORD 或 vm-credentials.cjs）");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSshClient, sshExec } = await jiti.import("../lib/ssh.ts");

const home = process.env.HOME ?? homedir();
const keyPath = process.env.QA_SSH_KEY ?? join(home, ".ssh", "qa_loopback");
const sshConfig = {
  host: process.env.QA_SSH_HOST ?? "127.0.0.1",
  port: Number(process.env.QA_SSH_PORT ?? 22),
  username: process.env.QA_SSH_USER ?? process.env.USER ?? "llmx",
  authType: "key",
  privateKey: readFileSync(keyPath, "utf8"),
};

const remoteRoot = `/tmp/pi-web-projection-http-${Date.now()}`;
const ssh = await getSshClient("e2e-projection-http", sshConfig);
const remotePath = (rel) => `${remoteRoot}/${rel}`;
const remoteText = async (rel) => (await sshExec(ssh, `cat ${JSON.stringify(remotePath(rel))}`, "/", 15_000)).stdout;

let cookies = "";
async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...(options.headers ?? {}),
    },
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    cookies = setCookies.map((entry) => entry.split(";")[0]).join("; ");
  }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

let projectId = "";
let projectHome = "";
try {
  await sshExec(ssh, `mkdir -p ${JSON.stringify(remoteRoot)}`, "/", 15_000);

  const login = await api("/api/webauth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.res.ok, true, `login failed: ${JSON.stringify(login.data)}`);

  const created = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: `projection-http-${Date.now()}`,
      mode: "ssh",
      workdir: remoteRoot,
      ssh: sshConfig,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.data));
  projectId = created.data.project.id;
  const ownerId = created.data.project.ownerId;
  projectHome = join(dataDir, "local-homes", `u${ownerId}`, projectId);

  mkdirSync(join(projectHome, ".pi/skills/http"), { recursive: true });
  writeFileSync(join(projectHome, ".pi/skills/http/SKILL.md"), "host-http-v1\n");

  const repaired = await api(`/api/projects/${projectId}/projection/repair`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(repaired.res.ok, true, JSON.stringify(repaired.data));
  assert.deepEqual(repaired.data.pushed, [".pi/skills/http/SKILL.md"]);
  assert.equal(await remoteText(".pi/skills/http/SKILL.md"), "host-http-v1\n");

  const status = await api(`/api/projects/${projectId}/projection`);
  assert.equal(status.res.ok, true, JSON.stringify(status.data));
  assert.equal(status.data.fileCount, 1);
  assert.deepEqual(status.data.dirty, []);

  await sshExec(ssh, `printf 'remote-local-edit\\n' > ${JSON.stringify(remotePath(".pi/skills/http/SKILL.md"))}`, "/", 15_000);
  const forced = await api(`/api/projects/${projectId}/projection/repair`, {
    method: "POST",
    body: JSON.stringify({ paths: [".pi/skills/http/SKILL.md"] }),
  });
  assert.equal(forced.res.ok, true, JSON.stringify(forced.data));
  assert.deepEqual(forced.data.pushed, [".pi/skills/http/SKILL.md"]);
  assert.equal(await remoteText(".pi/skills/http/SKILL.md"), "host-http-v1\n");

  console.log("PASS: projection HTTP (login/create/repair/status/force-push)");
} finally {
  if (projectId) {
    await api(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
  }
  if (projectHome) rmSync(projectHome, { recursive: true, force: true });
  await sshExec(ssh, `rm -rf ${JSON.stringify(remoteRoot)}`, "/", 15_000).catch(() => {});
  ssh.end();
}
