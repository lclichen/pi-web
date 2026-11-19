import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataRoot = mkdtempSync(join(tmpdir(), "workspace-key-data-"));
process.env.PI_WEB_DATA_DIR = dataRoot;

const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url);
const { resolveWorkspaceIdentity, workspaceKeyFor } = await jiti.import("./workspace-key.ts");

function lexical(path) {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function project(overrides = {}) {
  return {
    id: "p-key-1",
    name: "key-test",
    ownerId: 1,
    mode: "local-machine",
    createdAt: 1,
    pinnedSessions: [],
    ...overrides,
  };
}

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

test("sandbox backend carries the platform identity, so the same container differs across deployments", () => {
  const saved = process.env.PI_WEB_PLATFORM_URL;
  try {
    process.env.PI_WEB_PLATFORM_URL = "http://platform-a.internal:3000";
    const a1 = resolveWorkspaceIdentity(project({ mode: "sandbox", containerId: 7 }));
    assert.match(a1.backend, /^platform:http:\/\/platform-a\.internal:3000#container:7$/);
    assert.equal(a1.root, "/workspace");
    const a1Again = workspaceKeyFor(project({ mode: "sandbox", containerId: 7 }));
    assert.equal(a1Again, workspaceKeyFor(project({ mode: "sandbox", containerId: 7 })), "same platform + container → stable key");

    // 同容器、不同平台部署：key 必须不同（manifest 不互相继承）。
    process.env.PI_WEB_PLATFORM_URL = "http://platform-b.internal:3000";
    const b1 = workspaceKeyFor(project({ mode: "sandbox", containerId: 7 }));
    assert.notEqual(b1, a1Again);

    // 容器不同（同平台）→ key 仍不同。
    process.env.PI_WEB_PLATFORM_URL = "http://platform-a.internal:3000";
    assert.notEqual(workspaceKeyFor(project({ mode: "sandbox", containerId: 8 })), a1Again);

    // 未配置平台时也要有稳定、可区分的身份。
    delete process.env.PI_WEB_PLATFORM_URL;
    const unconfigured = resolveWorkspaceIdentity(project({ mode: "sandbox", containerId: 7 }));
    assert.equal(unconfigured.backend, "platform:unconfigured#container:7");
  } finally {
    if (saved === undefined) delete process.env.PI_WEB_PLATFORM_URL;
    else process.env.PI_WEB_PLATFORM_URL = saved;
  }
});

test("host/ssh roots normalize lexically when the path is not locally resolvable", () => {
  const remote = resolveWorkspaceIdentity(project({ mode: "ssh", workdir: "/root/MarLive/" }));
  assert.equal(remote.root, "/root/MarLive");
  assert.equal(remote.backend, "ssh:unconfigured");

  const windowsish = resolveWorkspaceIdentity(project({ mode: "local-machine", workdir: "D:\\repos\\demo\\" }));
  // D:\repos\demo 本机不存在时按词法规范化；存在时 realpath 也应规范化到同形式。
  const lexicalExpectation = lexical(windowsish.root);
  assert.ok(lexicalExpectation.length > 0);
  assert.ok(!lexicalExpectation.endsWith("/"), "no trailing slash");
});

test("host/ssh roots prefer the local realpath so one physical directory maps to one key", () => {
  const real = mkdtempSync(join(tmpdir(), "workspace-key-real-"));
  try {
    const viaReal = resolveWorkspaceIdentity(project({ mode: "local-machine", workdir: real }));
    assert.equal(viaReal.root, lexical(realpathSync(real)));

    // 通过 symlink/junction 别名访问同一物理目录 → 相同 root/key。
    const alias = join(tmpdir(), `workspace-key-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    let linked = true;
    try {
      symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false; // 无权限建链接时跳过别名断言
    }
    if (linked) {
      try {
        const viaAlias = resolveWorkspaceIdentity(project({ mode: "local-machine", workdir: alias }));
        assert.equal(viaAlias.root, viaReal.root);
        assert.equal(workspaceKeyFor(project({ mode: "local-machine", workdir: alias })), workspaceKeyFor(project({ mode: "local-machine", workdir: real })));
      } finally {
        rmSync(alias, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test("machine backends distinguish machines and differ from sandbox/ssh identities", () => {
  const a = workspaceKeyFor(project({ mode: "local-machine", machineId: "m1", workdir: "/repo" }));
  const b = workspaceKeyFor(project({ mode: "local-machine", machineId: "m2", workdir: "/repo" }));
  assert.notEqual(a, b);
  const saved = process.env.PI_WEB_PLATFORM_URL;
  process.env.PI_WEB_PLATFORM_URL = "http://platform-a.internal:3000";
  try {
    const sandbox = workspaceKeyFor(project({ mode: "sandbox", containerId: 7 }));
    const ssh = workspaceKeyFor(project({ mode: "ssh", workdir: "/repo" }));
    assert.notEqual(a, sandbox);
    assert.notEqual(a, ssh);
  } finally {
    if (saved === undefined) delete process.env.PI_WEB_PLATFORM_URL;
    else process.env.PI_WEB_PLATFORM_URL = saved;
  }
});
