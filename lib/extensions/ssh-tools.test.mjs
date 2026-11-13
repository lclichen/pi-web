import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * SSH 模式工具层单测：注入 getClient/exec，验证 SFTP/exec 参数映射、
 * 远程路径拼接、读改写、runtime-config 桥接与 user_bash 结算。
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { makeSshToolsExtension } = await jiti.import("./ssh-tools.ts");

const WORKDIR = "/srv/app";

function harness({ projectHome, execResult, files = {}, dirs = {} } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const execCalls = [];
  const sftpCalls = [];
  const sftp = {
    readFile(path, cb) {
      sftpCalls.push(["readFile", path]);
      if (!(path in files)) return cb(new Error(`ENOENT ${path}`));
      cb(null, Buffer.from(files[path], "utf8"));
    },
    writeFile(path, content, cb) {
      sftpCalls.push(["writeFile", path, content]);
      files[path] = content;
      cb(null);
    },
    readdir(path, cb) {
      sftpCalls.push(["readdir", path]);
      if (!(path in dirs)) return cb(new Error(`ENOENT ${path}`));
      cb(null, dirs[path]);
    },
    mkdir(dir, _opts, cb) {
      sftpCalls.push(["mkdir", dir]);
      cb(null);
    },
  };
  const client = {
    sftp: (cb) => cb(null, sftp),
    exec: null, // user_bash sets a per-test implementation
  };
  const exec = async (c, command, workdir, timeoutMs) => {
    execCalls.push({ command, workdir, timeoutMs });
    return execResult ?? { stdout: "ok\n", stderr: "", code: 0 };
  };
  const factory = makeSshToolsExtension({
    projectId: "p1",
    sshConfig: {},
    workdir: WORKDIR,
    projectHome,
    getClient: async () => client,
    exec,
  });
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
  };
  factory(pi);
  const execute = (name, params, ctx = { cwd: "/tmp" }) =>
    tools.get(name).execute("call-1", params, undefined, undefined, ctx);
  return { tools, handlers, client, execCalls, sftpCalls, files, execute };
}

test("bash runs over ssh in the remote workdir and marks non-zero as error", async () => {
  const h = harness();
  const ok = await h.execute("bash", { command: "ls -la", timeout: 30 });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(h.execCalls, [{ command: "ls -la", workdir: WORKDIR, timeoutMs: 30_000 }]);
  assert.match(ok.content[0].text, /ok/);

  const failing = harness({ execResult: { stdout: "", stderr: "nope", code: 2 } });
  const bad = await failing.execute("bash", { command: "false" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /\[stderr\]\nnope/);
  assert.match(bad.content[0].text, /\[exit 2\]/);
});

test("read joins relative paths, passes absolute paths, and numbers lines", async () => {
  const h = harness({ files: { "/srv/app/src/a.ts": "one\ntwo" } });
  const result = await h.execute("read", { path: "src/a.ts" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(h.sftpCalls[0], ["readFile", "/srv/app/src/a.ts"]);
  assert.match(result.content[0].text, /1→one\n2→two/);

  await h.execute("read", { path: "/etc/hosts" });
  assert.deepEqual(h.sftpCalls.at(-1), ["readFile", "/etc/hosts"]);
});

test("write creates the parent directory and writes remote content", async () => {
  const h = harness();
  const result = await h.execute("write", { path: "src/new.txt", content: "hello" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(h.sftpCalls[0], ["mkdir", "/srv/app/src"]);
  assert.deepEqual(h.sftpCalls[1], ["writeFile", "/srv/app/src/new.txt", "hello"]);
  assert.match(result.content[0].text, /5 bytes/);
});

test("edit does SFTP read-modify-write and rejects missing text", async () => {
  const h = harness({ files: { "/srv/app/a.txt": "alpha\nbeta" } });
  const ok = await h.execute("edit", { path: "a.txt", oldText: "beta", newText: "gamma" });
  assert.equal(ok.isError, undefined);
  const write = h.sftpCalls.find((c) => c[0] === "writeFile");
  assert.equal(write[2], "alpha\ngamma");

  const missing = await h.execute("edit", { path: "a.txt", oldText: "nope", newText: "x" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);
});

test("ls formats directory entries and handles empty dirs", async () => {
  const h = harness({
    dirs: {
      "/srv/app/src": [
        { filename: "b.ts", attrs: { isDirectory: () => false, size: 1 } },
        { filename: "a", attrs: { isDirectory: () => true, size: 1 } },
      ],
      "/srv/app/empty": [],
    },
  });
  const list = await h.execute("ls", { path: "src" });
  assert.equal(list.content[0].text, "- b.ts" + String.fromCharCode(10) + "d a");
  const empty = await h.execute("ls", { path: "empty" });
  assert.equal(empty.content[0].text, "(empty)");
});

test("grep/find build quoted remote commands and handle no matches", async () => {
  const h = harness({ execResult: { stdout: "a.ts:1: x\n", stderr: "", code: 0 } });
  await h.execute("grep", { pattern: "a'b", include: "*.ts" });
  const grep = h.execCalls.at(-1).command;
  assert.match(grep, /^grep -rnE --include='\*\.ts' -- 'a'\\''b' \/srv\/app 2>\/dev\/null \| head -100$/);

  await h.execute("find", { pattern: "*.yaml", path: "conf" });
  const find = h.execCalls.at(-1).command;
  assert.match(find, /^find \/srv\/app\/conf -name '\*\.yaml' 2>\/dev\/null \| head -100$/);

  const none = harness({ execResult: { stdout: "", stderr: "", code: 1 } });
  assert.equal((await none.execute("grep", { pattern: "zzz" })).content[0].text, "No matches");
  assert.equal((await none.execute("find", { pattern: "*.none" })).content[0].text, "No matches");
});

test("runtime-config bridge serves skills locally instead of SFTP", async () => {
  const home = mkdtempSync(join(tmpdir(), "ssh-bridge-"));
  try {
    mkdirSync(join(home, ".pi", "skills", "demo"), { recursive: true });
    writeFileSync(join(home, ".pi", "skills", "demo", "SKILL.md"), "ssh skill\n");
    const h = harness({ projectHome: home });
    const result = await h.execute("read", { path: ".pi/skills/demo/SKILL.md" }, { cwd: home });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /ssh skill/);
    assert.equal(h.sftpCalls.length, 0, "bridged read must not touch SFTP");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("user_bash runs on the remote host with cd into the workdir", async () => {
  const h = harness();
  const pending = [];
  h.client.exec = (command, cb) => pending.push({ command, cb });
  const handler = h.handlers.get("user_bash");
  assert.ok(handler, "user_bash handler registered");
  const { operations } = await handler();
  const chunks = [];
  const done = operations.exec("echo hi", "/server/home", {
    onData: (buf) => chunks.push(buf.toString("utf8")),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  assert.match(pending[0].command, /^cd '\/srv\/app'.*\{ echo hi; \}/);

  const stream = {
    data: null,
    close: null,
    stderr: { data: null },
    on(event, cb) {
      if (event === "data") stream.data = cb;
      if (event === "close") stream.close = cb;
      return stream;
    },
    closeStream() {},
  };
  stream.stderr.on = (event, cb) => {
    if (event === "data") stream.stderr.data = cb;
    return stream.stderr;
  };
  pending[0].cb(null, stream);
  stream.data?.(Buffer.from("hi\n"));
  stream.close?.(0);
  const result = await done;
  assert.equal(result.exitCode, 0);
  assert.match(chunks.join(""), /hi/);
});
