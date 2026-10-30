import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sshPath, localWirePath, containerPath } = await jiti.import("./remote-session.ts");

/**
 * 远程文件面板的路径归一。输入恒为 POSIX 绝对形态（/api/remotefs 的
 * catch-all 会补前导斜杠），但要区分两类：
 *   · 虚拟根路径 "/poem.txt"（"/" = 工作区根）——按相对处理；
 *   · 真·绝对路径（会话收尾/聊天链接回显完整工作目录）——已含根前缀，
 *     必须先剥掉，否则 agent/远端会拼出 <base>/<base>/file（stat 失败）。
 */

test("ssh: virtual-root paths map under the workdir", () => {
  const ctx = { workdir: "/infra_home/ai0944/project_path" };
  assert.equal(sshPath(ctx, "/poem.txt"), "/infra_home/ai0944/project_path/poem.txt");
  assert.equal(sshPath(ctx, "/"), "/infra_home/ai0944/project_path");
});

test("ssh: absolute paths already carrying the workdir are unwrapped, not doubled", () => {
  const ctx = { workdir: "/infra_home/ai0944/project_path" };
  assert.equal(
    sshPath(ctx, "/infra_home/ai0944/project_path/poem.txt"),
    "/infra_home/ai0944/project_path/poem.txt",
  );
  assert.equal(sshPath(ctx, "/infra_home/ai0944/project_path"), "/infra_home/ai0944/project_path");
});

test("local-machine: base strategy unwraps absolute-under-workdir", () => {
  const ctx = { workdir: "/infra_home/ai0944/project_path" };
  const scope = { base: "/infra_home/ai0944/project_path" };
  // 双拼回归：完整绝对路径必须映射为相对，而不是 base+绝对。
  assert.equal(localWirePath(ctx, "/infra_home/ai0944/project_path/poem.txt", scope), "poem.txt");
  assert.equal(localWirePath(ctx, "/poem.txt", scope), "poem.txt");
  assert.equal(localWirePath(ctx, "/", scope), ".");
});

test("local-machine: legacy prefix strategy stays correct for both forms", () => {
  const ctx = { workdir: "/srv/ws" };
  const scope = { prefix: "ws" };
  assert.equal(localWirePath(ctx, "/poem.txt", scope), "ws/poem.txt");
  assert.equal(localWirePath(ctx, "/srv/ws/poem.txt", scope), "ws/poem.txt");
  assert.equal(localWirePath(ctx, "/srv/ws", scope), "ws");
});

test("local-machine: without a bound workdir, absolutes pass through", () => {
  const scope = {};
  assert.equal(localWirePath({}, "/srv/elsewhere/x.txt", scope), "/srv/elsewhere/x.txt");
  assert.equal(localWirePath({}, "poem.txt", scope), "poem.txt");
});

test("sandbox: /workspace-prefixed absolutes are not doubled", () => {
  assert.equal(containerPath("/poem.txt"), "/workspace/poem.txt");
  assert.equal(containerPath("/workspace/poem.txt"), "/workspace/poem.txt");
  assert.equal(containerPath("/workspace"), "/workspace");
  assert.equal(containerPath("/"), "/workspace");
});
