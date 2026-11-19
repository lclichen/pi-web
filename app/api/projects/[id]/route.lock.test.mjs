import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * ADR-0004 §4.2（P2-5）：项目 PATCH 的 home 配置写入（models/auth/AGENTS.md/
 * sandbox 凭据）走 withProjectConfigWriteLock。验证：
 *  1. 与进行中的配置写（如 sync apply/bundle apply）串行——第二次写进入时
 *     第一次已完成（锁顺序性），落盘不出现半写；
 *  2. 跨进程锁竞争（proper-lockfile ELOCKED）→ 409 PROJECT_LOCKED；
 *  3. 校验前置：一项凭据非法时整个 PATCH 400，不落任何半写。
 */
const root = await mkdtempSync(join(tmpdir(), "pi-web-project-patch-lock-"));
const previousEnv = {
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
};
process.env.PI_WEB_DATA_DIR = join(root, "data");
process.env.PI_WEB_AUTH = "on";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("@/lib/web-session.ts");
const { createProject, ensureProjectHome } = await jiti.import("@/lib/projects.ts");
// 注意与 route.ts 内部使用完全一致的裸说明符（不带 .ts）：jiti 按说明符缓存，
// 两种写法会得到两个模块实例、两把进程内 RW 锁——测试持锁就会退化为文件锁
// ELOCKED（409）而不是预期的排队。
const { withProjectConfigWriteLock } = await jiti.import("@/lib/project-config-lock");
const { PATCH } = await jiti.import("./route.ts");
const lockfile = (await import("proper-lockfile")).default;

function sessionCookie() {
  const session = createWebSession(
    { id: 1, username: "admin", email: null, role: "admin", status: "active" },
    "sk_test",
    1,
  );
  return `${WEB_SESSION_COOKIE}=${session.sid}`;
}

function patchRequest(projectId, body) {
  return new Request(`http://localhost/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { host: "localhost", cookie: sessionCookie(), "content-type": "application/json" },
    body: JSON.stringify(body),
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

test("PATCH config writes queue behind an in-flight writer (ordered, no half writes)", async () => {
  const created = await createProject({ name: "patch-lock-order", ownerId: 1, mode: "local-machine" });
  assert.equal(created.ok, true);
  const project = created.project;
  const home = ensureProjectHome(project);
  const fs = await import("node:fs");
  fs.mkdirSync(join(home, ".pi"), { recursive: true });
  const modelsPath = join(home, ".pi", "models.json");

  // 第一次写：持写锁模拟进行中的 sync apply/bundle apply，先落一步再挂起。
  let resumeFirst;
  const first = withProjectConfigWriteLock(project.id, async () => {
    writeFileSync(modelsPath, '{"step":"first"}', "utf8");
    await new Promise((resolve) => {
      resumeFirst = resolve;
    });
  });

  // 第二次写：并发 PATCH。进入锁前不得触碰 models.json。
  // 先等首次写入真正落盘（全量并发下锁获取可能超过固定睡眠窗口，读到
  // ENOENT 会假失败），再发 PATCH 并在窗口内确认内容保持 first。
  const firstWritten = await (async () => {
    for (let i = 0; i < 100; i += 1) {
      try {
        if (readFileSync(modelsPath, "utf8") === '{"step":"first"}') return true;
      } catch {
        /* 尚未写入 */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  })();
  assert.equal(firstWritten, true, "首次写入应在合理时间内落盘");
  const second = PATCH(patchRequest(project.id, { modelsJson: '{"step":"second"}' }), routeCtx(project.id));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFileSync(modelsPath, "utf8"), '{"step":"first"}', "PATCH 在第一次写完成前不得落盘（锁顺序性）");

  resumeFirst();
  await first;
  const res = await second;
  assert.equal(res.status, 200);
  // 顺序证明：第二次写进入时第一次已完成 → 最终内容是 PATCH 的值，且始终是合法 JSON。
  assert.equal(readFileSync(modelsPath, "utf8"), '{"step":"second"}');
  JSON.parse(readFileSync(modelsPath, "utf8"));
});

test("an external file lock makes PATCH fail fast with 409 PROJECT_LOCKED", async () => {
  const created = await createProject({ name: "patch-lock-busy", ownerId: 1, mode: "local-machine" });
  assert.equal(created.ok, true);
  const project = created.project;
  const lockDir = join(process.env.PI_WEB_DATA_DIR, "locks", project.id);
  const fs = await import("node:fs");
  fs.mkdirSync(lockDir, { recursive: true });
  const release = await lockfile.lock(lockDir, { realpath: false, retries: 0 });
  try {
    const res = await PATCH(patchRequest(project.id, { modelsJson: '{"k":1}' }), routeCtx(project.id));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "PROJECT_LOCKED");
  } finally {
    await release();
  }
});

test("invalid credentials validate before any write (no partial PATCH)", async () => {
  const created = await createProject({ name: "patch-lock-validate", ownerId: 1, mode: "local-machine" });
  assert.equal(created.ok, true);
  const project = created.project;
  const home = ensureProjectHome(project);

  const res = await PATCH(
    patchRequest(project.id, { modelsJson: '{"ok":true}', authJson: "not-json" }),
    routeCtx(project.id),
  );
  assert.equal(res.status, 400);
  // 合法的 modelsJson 也不得先行落盘（校验全部前置）。
  const fs = await import("node:fs");
  assert.equal(fs.existsSync(join(home, ".pi", "models.json")), false);
});
