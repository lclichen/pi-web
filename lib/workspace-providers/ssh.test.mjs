import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSshWorkspaceOperations } = await jiti.import("./ssh.ts");

function fakeSsh(initial = {}, options = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set(["/w", "/w/.pi"]);
  let channels = 0;
  let closed = 0;
  const wrapper = {
    end() {
      closed += 1;
    },
    readFile(path, cb) {
      if (!files.has(path)) return cb(Object.assign(new Error("no such file"), { code: 2 }));
      cb(null, Buffer.from(files.get(path)));
    },
    writeFile(path, content, cb) {
      files.set(path, String(content));
      cb(null);
    },
    mkdir(_path, opts, cb) {
      if (typeof opts === "function") cb = opts;
      cb(null);
    },
    stat(path, cb) {
      const mtime = options.statMtime ?? 1;
      if (dirs.has(path)) return cb(null, { isDirectory: () => true, size: 0, mtime });
      if (files.has(path)) return cb(null, { isDirectory: () => false, size: files.get(path).length, mtime });
      cb(Object.assign(new Error("no such file"), { code: 2 }));
    },
    readdir(path, cb) {
      const prefix = `${path.replace(/\/+$/, "")}/`;
      const names = new Set();
      for (const file of files.keys()) {
        if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) names.add(file.slice(prefix.length));
      }
      for (const dir of dirs) {
        if (dir.startsWith(prefix) && dir !== path && !dir.slice(prefix.length).includes("/")) {
          names.add(dir.slice(prefix.length));
        }
      }
      cb(
        null,
        [...names].map((name) => ({
          filename: name,
          attrs: {
            isDirectory: () => dirs.has(`${prefix}${name}`),
            size: files.get(`${prefix}${name}`)?.length ?? 0,
            mtime: options.statMtime ?? 1,
          },
        })),
      );
    },
  };
  const client = {
    sftp(cb) {
      channels += 1;
      cb(null, wrapper);
    },
    exec(_command, cb) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      cb(null, stream);
      setImmediate(() => {
        if (options.execOutput) stream.emit("data", Buffer.from(options.execOutput));
        stream.emit("close", options.execError ? 1 : 0);
      });
    },
  };
  return { client, files, stats: () => ({ channels, closed }) };
}

test("SSH provider closes every SFTP channel it opens", async () => {
  const ssh = fakeSsh({ "/w/.pi/a.txt": "hello" });
  const ws = createSshWorkspaceOperations({ getClient: async () => ssh.client, workdir: "/w" });

  assert.equal((await ws.readFile(".pi/a.txt")).toString(), "hello");
  assert.equal((await ws.stat(".pi/a.txt")).size, 5);
  assert.equal((await ws.readdir(".pi")).some((e) => e.name === "a.txt"), true);
  await ws.writeFile(".pi/b.txt", "world");
  assert.equal(ssh.files.get("/w/.pi/b.txt"), "world");
  assert.deepEqual(ssh.stats(), { channels: 4, closed: 4 });
});

test("SSH provider rejects paths outside the workspace root", async () => {
  const ssh = fakeSsh({});
  const ws = createSshWorkspaceOperations({ getClient: async () => ssh.client, workdir: "/w" });
  await assert.rejects(() => ws.readFile("../etc/passwd"), /escapes the workspace/);
  await assert.rejects(() => ws.readFile("/etc/passwd"), /escapes the workspace/);
});

test("SSH provider manifest parses find output relative to the workspace root", async () => {
  const output = ["5\t1700000000.5\t/w/.pi/skills/a/SKILL.md", "3\t1700000001\t/w/.pi/attachments/p.bin", ""].join("\n");
  const ssh = fakeSsh({}, { execOutput: output });
  const ws = createSshWorkspaceOperations({ getClient: async () => ssh.client, workdir: "/w" });
  const result = await ws.manifest([".pi/skills", ".pi/attachments"]);
  assert.equal(result.truncated, false);
  // 亚秒小数截断到整秒（与 SFTP stat 对齐），四舍五入会得到 ...000500。
  assert.deepEqual(result.entries, [
    { path: ".pi/skills/a/SKILL.md", size: 5, mtimeMs: 1_700_000_000_000 },
    { path: ".pi/attachments/p.bin", size: 3, mtimeMs: 1_700_000_001_000 },
  ]);
});

test("SSH manifest mtimes with sub-second precision still hit the stat fast path", async () => {
  // find %T@ 带亚秒小数、SFTP stat 的 mtime 为整秒：两侧必须相等，reconcile
  // 的 size+mtime 快路径才命中（否则每个文件都退化为全量读）。
  const output = "5\t1700000000.75\t/w/.pi/skills/a/SKILL.md\n";
  const ssh = fakeSsh({ "/w/.pi/skills/a/SKILL.md": "hello" }, { execOutput: output, statMtime: 1_700_000_000 });
  const ws = createSshWorkspaceOperations({ getClient: async () => ssh.client, workdir: "/w" });
  const manifest = await ws.manifest([".pi/skills"]);
  const stat = await ws.stat(".pi/skills/a/SKILL.md");
  assert.equal(manifest.entries[0].mtimeMs, stat.mtimeMs);
  assert.equal(manifest.entries[0].size, stat.size);
});

test("SSH provider manifest reports UNSUPPORTED when find fails without output", async () => {
  const ssh = fakeSsh({}, { execError: true });
  const ws = createSshWorkspaceOperations({ getClient: async () => ssh.client, workdir: "/w" });
  await assert.rejects(
    () => ws.manifest([".pi/skills"]),
    (error) => error.code === "UNSUPPORTED",
  );
});
