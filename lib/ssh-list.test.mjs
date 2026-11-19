import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseSshDirectoryListing, stripSshExecFence, probeSshClientAlive, sshExec } = await jiti.import("./ssh.ts");

/** Fake exec channel: ssh2 语义的 close/exit/end + stderr 侧信道。 */
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

const OUTPUT = [
  "Welcome to AMEDAC appliance",
  "@@PI_SSH_LIST_BEGIN@@",
  "@@PI_SSH_LIST_PATH@@/srv/app",
  "@@PI_SSH_LIST_DIR@@src",
  "@@PI_SSH_LIST_DIR@@docs",
  "@@PI_SSH_LIST_END@@",
  "logout banner",
].join("\n");

test("the fenced listing ignores server banners before and after", () => {
  assert.deepEqual(parseSshDirectoryListing(OUTPUT), {
    path: "/srv/app",
    entries: [
      { name: "docs", isDir: true, size: 0 },
      { name: "src", isDir: true, size: 0 },
    ],
  });
});

test("CRLF output and a trailing slash on the path are tolerated", () => {
  const crlf = OUTPUT.replace(/\n/g, "\r\n").replace("/srv/app", "/srv/app/");
  assert.equal(parseSshDirectoryListing(crlf)?.path, "/srv/app");
});

test("missing markers are reported as unparseable, not as an empty directory", () => {
  assert.equal(parseSshDirectoryListing("Welcome\n/srv/app\nsrc\n"), null);
  assert.equal(parseSshDirectoryListing("@@PI_SSH_LIST_BEGIN@@\nsrc\n"), null);
});

test("exec fences drop .bashrc/startup output but keep the command result", () => {
  const stdout =
    "AMEDAC welcome\n" +
    "@@PI_SSH_EXEC_BEGIN_a1b2c3d4e5f60708@@\n" +
    "real stdout\n" +
    "\n@@PI_SSH_EXEC_END_a1b2c3d4e5f60708@@ 0\n";
  assert.deepEqual(stripSshExecFence(stdout), { text: "real stdout\n", code: 0 });

  const stderr =
    "banner on stderr\n@@PI_SSH_EXEC_BEGIN_a1b2c3d4e5f60708@@\noops\n\n@@PI_SSH_EXEC_END_a1b2c3d4e5f60708@@ 2\n";
  assert.deepEqual(stripSshExecFence(stderr), { text: "oops\n", code: 2 });
});

test("a command that replaced the shell keeps its output after the begin marker", () => {
  const stdout = "banner\n@@PI_SSH_EXEC_BEGIN_a1b2c3d4e5f60708@@\npartial output\n";
  assert.deepEqual(stripSshExecFence(stdout), { text: "partial output\n" });
});

test("output without a fence is returned unchanged (older/odd shells)", () => {
  assert.deepEqual(stripSshExecFence("plain\n"), { text: "plain\n" });
});

test("the pool health probe settles alive on exit-status without a channel close", async () => {
  const stream = fakeStream();
  const client = {
    exec(_command, cb) {
      setImmediate(() => {
        cb(null, stream);
        // 只发 exit-status 不关 channel 的服务器：close-only 探针会白等满
        // 3 秒然后误判连接已死。
        stream.emit("exit", 0);
      });
    },
  };
  const started = Date.now();
  assert.equal(await probeSshClientAlive(client), true);
  assert.ok(Date.now() - started < 2_500, "must settle on exit, not burn the 3s probe timeout");
  // 主动收尾探测通道：exit-only 服务器不会自己关，留着会累积到 MaxSessions。
  assert.equal(stream.closed, true);
});

test("the probe still settles alive on a plain close and closes the channel at the timeout", async (t) => {
  const closeOnly = fakeStream();
  const closeClient = {
    exec(_command, cb) {
      setImmediate(() => {
        cb(null, closeOnly);
        closeOnly.emit("close");
      });
    },
  };
  assert.equal(await probeSshClientAlive(closeClient), true);

  // 两个事件都不发：超时必须判死并关掉探测通道，而不是永久挂起。
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hung = fakeStream();
  const hungClient = {
    exec(_command, cb) {
      cb(null, hung);
    },
  };
  const pending = probeSshClientAlive(hungClient);
  t.mock.timers.tick(3_000);
  assert.equal(await pending, false);
  assert.equal(hung.closed, true);
});

test("sshExec settles with the real exit code on servers that never close the channel", async () => {
  const stream = fakeStream();
  const client = {
    exec(_script, cb) {
      setImmediate(() => {
        cb(null, stream);
        stream.emit("data", Buffer.from("done\n"));
        stream.emit("exit", 3);
        // 故意不发 close：close-only 结算会等到超时并把退出码误报成 124。
      });
    },
  };
  const result = await sshExec(client, "cmd", "/tmp");
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "done\n");
  assert.equal(stream.closed, true, "the channel is closed after exit settlement");
});

test("sshExec still finalizes on close when the server sends no exit-status", async () => {
  const stream = fakeStream();
  const client = {
    exec(_script, cb) {
      setImmediate(() => {
        cb(null, stream);
        stream.emit("close", 7);
      });
    },
  };
  const result = await sshExec(client, "cmd", "/tmp");
  assert.equal(result.code, 7);
});

test("sshExec flushes trailing output that arrives after exit-status", async () => {
  const stream = fakeStream();
  const client = {
    exec(script, cb) {
      setImmediate(() => {
        const begin = /@@PI_SSH_EXEC_BEGIN_[0-9a-f]+@@/.exec(script)[0];
        const end = /@@PI_SSH_EXEC_END_[0-9a-f]+@@/.exec(script)[0];
        cb(null, stream);
        stream.emit("data", Buffer.from(`banner\n${begin}\npart1\n`));
        stream.emit("exit", 0);
        // 在途的 trailing 数据块在 exit-status 之后才送达：立即结算会截断
        // 输出并让围栏 END 解析失败（围栏文本被当作正文原样返回）。
        setTimeout(() => stream.emit("data", Buffer.from(`part2\n\n${end} 0\n`)), 5);
      });
    },
  };
  const result = await sshExec(client, "cmd", "/tmp");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "part1\npart2\n");
});

test("sshExec prefers the fence's embedded rc over the raw exit code", async () => {
  const stream = fakeStream();
  const client = {
    exec(script, cb) {
      setImmediate(() => {
        const begin = /@@PI_SSH_EXEC_BEGIN_[0-9a-f]+@@/.exec(script)[0];
        const end = /@@PI_SSH_EXEC_END_[0-9a-f]+@@/.exec(script)[0];
        cb(null, stream);
        stream.emit("data", Buffer.from(`banner\n${begin}\nhello\n\n${end} 0\n`));
        stream.emit("exit", 5);
      });
    },
  };
  const result = await sshExec(client, "cmd", "/tmp");
  assert.equal(result.code, 0, "fence rc wins over exit-status");
  assert.equal(result.stdout, "hello\n");
});
