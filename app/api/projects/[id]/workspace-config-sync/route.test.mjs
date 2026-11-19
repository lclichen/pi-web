import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = await mkdtempSync(join(tmpdir(), "pi-web-wcs-route-"));
const previousEnv = {
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
  PI_WEB_PLATFORM_URL: process.env.PI_WEB_PLATFORM_URL,
};
process.env.PI_WEB_DATA_DIR = join(root, "data");
process.env.PI_WEB_AUTH = "on";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("@/lib/web-session.ts");
const { createProject, ensureProjectHome } = await jiti.import("@/lib/projects.ts");
const { workspaceKeyFor } = await jiti.import("@/lib/workspace-key.ts");
const { saveSyncPlan, loadSyncPlan } = await jiti.import("@/lib/sync-plan-store.ts");
const { POST } = await jiti.import("./route.ts");

function sessionCookie() {
  const session = createWebSession(
    { id: 1, username: "admin", email: null, role: "admin", status: "active" },
    "sk_test",
    1,
  );
  return `${WEB_SESSION_COOKIE}=${session.sid}`;
}

function applyRequest(projectId, token) {
  return new Request(`http://localhost/api/projects/${projectId}/workspace-config-sync`, {
    method: "POST",
    headers: { host: "localhost", cookie: sessionCookie(), "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

const routeCtx = (projectId) => ({ params: Promise.resolve({ id: projectId }) });

test.after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rmSync(root, { recursive: true, force: true });
});

test("a baseline conflict returns 409 and voids the preview token", async () => {
  const created = await createProject({ name: "wcs-conflict", ownerId: 1, mode: "local-machine" });
  assert.equal(created.ok, true);
  const project = created.project;
  const workspaceKey = workspaceKeyFor(project);

  // 预览后项目区文件被改动：baseline 里记录的 hash 与 home 现状不符。
  const home = ensureProjectHome(project);
  mkdirSync(join(home, ".pi", "skills", "demo"), { recursive: true });
  writeFileSync(join(home, ".pi", "skills", "demo", "SKILL.md"), "drifted\n");

  const { token } = await saveSyncPlan({
    userId: 1,
    projectId: project.id,
    workspaceKey,
    stats: { files: 1, bytes: 4, added: 1, overwritten: 0, unchanged: 0, skipped: 0, skippedPaths: [] },
    baseline: { ".pi/skills/demo/SKILL.md": "0".repeat(64) },
    preview: [
      { rel: ".pi/skills/demo/SKILL.md", change: "added", existed: false, oldBytes: 0, newBytes: 4, binary: false, risk: "normal" },
    ],
    writes: [{ rel: ".pi/skills/demo/SKILL.md", content: Buffer.from("new\n"), existed: false }],
  });

  const res = await POST(applyRequest(project.id, token), routeCtx(project.id));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "BASELINE_CONFLICT");
  assert.deepEqual(body.changed, [".pi/skills/demo/SKILL.md"]);

  // ADR §4.1：409 并作废 token —— 再次提交同 token 直接 410（missing）。
  assert.deepEqual(await loadSyncPlan(token), { ok: false, reason: "missing" });
  const again = await POST(applyRequest(project.id, token), routeCtx(project.id));
  assert.equal(again.status, 410);
  const againBody = await again.json();
  assert.equal(againBody.reason, "missing");
});
