import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSshWorkspaceOperations } = await jiti.import("./ssh.ts");

function fakeSsh(initial = {}) {
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
    mkdir(_path, _opts, cb) {
      cb(null);
    },
    stat(path, cb) {
      if (dirs.has(path)) return cb(null, { isDirectory: () => true, size: 0, mtime: 1 });
      if (files.has(path)) return cb(null, { isDirectory: () => false, size: files.get(path).length, mtime: 1 });
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
            mtime: 1,
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
