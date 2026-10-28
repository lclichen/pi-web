import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * 目录契约（lib/session-context.ts）：projectDir 永远是服务器侧 home，
 * workspaceDir 按模式映射。钉住两条曾出事故的不变量：
 *   1. local-machine 项目的 workdir（用户机器路径）绝不能成为 projectDir
 *      ——SDK 会在服务器上 resolve 成 `<repo>/D:\…` 混合路径写进会话头。
 *   2. ssh 的 workdir 只作为 workspaceDir 透传。
 */

async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-ctx-"));
  const prev = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("local-machine project: workdir stays workspace-only, projectDir is the server home", async () => {
  await withDataDir(async () => {
    const { sessionDirsForProject } = await jiti.import("./session-context.ts");
    const dirs = sessionDirsForProject(
      { id: "p1", mode: "local-machine", name: "我的电脑", ownerId: 1, workdir: "D:\\work\\repo" },
      "/srv/homes/u1/p1",
    );
    assert.equal(dirs.projectDir, "/srv/homes/u1/p1");
    assert.equal(dirs.workspaceDir, "D:\\work\\repo");
    assert.equal(dirs.workspaceKind, "local-agent");
    // 会话 cwd 必须可直接在服务器上使用（不包含远端路径成分）。
    assert.ok(!dirs.projectDir.includes("D:"), "projectDir must not embed agent-side paths");
  });
});

test("local-machine project without bound workdir falls back to the shared-root note", async () => {
  await withDataDir(async () => {
    const { sessionDirsForProject } = await jiti.import("./session-context.ts");
    const dirs = sessionDirsForProject({ id: "p2", mode: "local-machine", name: "x", ownerId: 1 }, "/srv/homes/u1/p2");
    assert.equal(dirs.projectDir, "/srv/homes/u1/p2");
    assert.equal(dirs.workspaceKind, "local-agent");
  });
});

test("sandbox and ssh map to container/remote workspaces with the server home as projectDir", async () => {
  await withDataDir(async () => {
    const { sessionDirsForProject } = await jiti.import("./session-context.ts");
    const sandbox = sessionDirsForProject({ id: "p3", mode: "sandbox", name: "s", ownerId: 1 }, "/srv/homes/u1/p3");
    assert.equal(sandbox.projectDir, "/srv/homes/u1/p3");
    assert.equal(sandbox.workspaceDir, "/workspace");
    assert.equal(sandbox.workspaceKind, "container");

    const ssh = sessionDirsForProject(
      { id: "p4", mode: "ssh", name: "r", ownerId: 1, workdir: "/srv/apps/web" },
      "/srv/homes/u1/p4",
    );
    assert.equal(ssh.projectDir, "/srv/homes/u1/p4");
    assert.equal(ssh.workspaceDir, "/srv/apps/web");
    assert.equal(ssh.workspaceKind, "remote-ssh");
  });
});

test("standalone host/quick sessions keep projectDir = workspaceDir", async () => {
  await withDataDir(async () => {
    const { sessionDirsForStandalone } = await jiti.import("./session-context.ts");
    const host = sessionDirsForStandalone("host", "/home/op/data");
    assert.equal(host.projectDir, "/home/op/data");
    assert.equal(host.workspaceDir, "/home/op/data");
    assert.equal(host.workspaceKind, "server");

    const quick = sessionDirsForStandalone("quick", "/srv/quick/u1");
    assert.equal(quick.projectDir, "/srv/quick/u1");
    assert.equal(quick.workspaceKind, "server");
  });
});

test("agent/new no longer routes project.workdir into the session cwd", async () => {
  // 源码形状断言：创建路由必须引用 session-context 的 projectDir 语义，
  // 且不再出现 boundWorkdir（曾把用户机器路径直接当会话 cwd）。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.ok(src.includes("sessionDirsForProject"), "route must resolve dirs via session-context");
  assert.ok(!src.includes("boundWorkdir"), "boundWorkdir must be gone");
  assert.match(src, /effectiveCwd = home;/, "project sessions run in the server home");
});

test("environment-info states the workspace and the config-source contract", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./extensions/environment-info.ts", import.meta.url), "utf8");
  assert.match(src, /工作区目录/, "prompt names the workspace dir");
  assert.match(src, /项目配置目录/, "prompt names the project dir as config source");
  assert.match(src, /workspaceDir\?: string/, "EnvironmentInfo carries workspaceDir");
});
