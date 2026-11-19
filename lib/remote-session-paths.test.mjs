import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sshPath, localWirePath, containerPath, remoteFind } = await jiti.import("./remote-session.ts");
const { seedSshPoolForTest } = await jiti.import("./ssh.ts");

function fakeStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closed = false;
  stream.close = () => {
    stream.closed = true;
  };
  stream.end = () => {};
  stream.resume = () => {};
  stream.stderr.resume = () => {};
  return stream;
}

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

test("ssh file operations go through the bounded, closing SFTP helper", async () => {
  const source = await readFile(new URL("./remote-session.ts", import.meta.url), "utf8");
  // Every SSH file verb (list/read/readBinary/write/writeBytes) must use the
  // helper: raw client.sftp() channels leaked until MaxSessions rejected new
  // opens with "Channel open failure: open failed".
  assert.doesNotMatch(source, /sftpOf|\.sftp\(/);
  assert.match(source, /import \{ withSftp \} from "\.\/ssh-sftp\.ts"/);
  assert.ok((source.match(/withSftp\(/g) ?? []).length >= 5);
});

test("ssh remoteFind settles on exit-status without a channel close", async () => {
  const client = {
    exec(command, cb) {
      const stream = fakeStream();
      setImmediate(() => {
        cb(null, stream);
        if (command === "true") return stream.emit("exit", 0); // 连接池探针
        stream.emit("data", Buffer.from("./a.ts\n./b/c.ts\n"));
        // 只发 exit-status 不关 channel：close-only 结算会永久挂起。
        stream.emit("exit", 0);
      });
    },
  };
  seedSshPoolForTest("proj-find-exit", client);
  const ctx = {
    mode: "ssh",
    projectId: "proj-find-exit",
    sshConfig: { host: "h", port: 22, username: "u" },
    workdir: "/srv/app",
  };
  const result = await remoteFind(ctx, "/", ".ts");
  assert.deepEqual(result, ["a.ts", "b/c.ts"]);
});

test("ssh remoteFind times out and resolves empty instead of hanging forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  const client = {
    exec(command, cb) {
      const stream = fakeStream();
      if (command === "true") setImmediate(() => stream.emit("exit", 0)); // 探针判活
      cb(null, stream); // find 本体既不 exit 也不 close
    },
  };
  seedSshPoolForTest("proj-find-hang", client);
  const ctx = {
    mode: "ssh",
    projectId: "proj-find-hang",
    sshConfig: { host: "h", port: 22, username: "u" },
    workdir: "/srv/app",
  };
  const pending = remoteFind(ctx, "/", "x");
  await new Promise((resolve) => setImmediate(resolve)); // 探针先经 setImmediate 判活
  t.mock.timers.tick(120_000);
  assert.deepEqual(await pending, []);
  assert.equal(warn.mock.calls.length >= 1, true, "timeout is marked with a warning");
  assert.match(String(warn.mock.calls[0].arguments[0]), /超时/);
});
