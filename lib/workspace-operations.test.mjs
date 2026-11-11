import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  WorkspaceOperationError,
  toReadOperations,
  toWriteOperations,
  toEditOperations,
  toLsOperations,
  toBashOperations,
} = await jiti.import("./workspace-operations.ts");

function fakeWorkspace(overrides = {}) {
  const files = new Map([["/ws/a.txt", Buffer.from("hello")]]);
  const calls = [];
  const ws = {
    version: 1,
    root: "/ws",
    capabilities: { read: true, write: true, exec: true },
    async canonicalize(path) {
      if (!path.startsWith("/ws/") && path !== "/ws") throw new WorkspaceOperationError("OUT_OF_SCOPE", path);
      return path;
    },
    async readFile(path) {
      calls.push(["readFile", path]);
      const data = files.get(path);
      if (!data) throw new WorkspaceOperationError("NOT_FOUND", path);
      return data;
    },
    async writeFile(path, content) {
      calls.push(["writeFile", path, content]);
      files.set(path, Buffer.from(content));
    },
    async mkdir(path) {
      calls.push(["mkdir", path]);
    },
    async stat(path) {
      calls.push(["stat", path]);
      if (path === "/ws") return { isFile: false, isDirectory: true, size: 0, mtimeMs: 1 };
      const data = files.get(path);
      if (!data) throw new WorkspaceOperationError("NOT_FOUND", path);
      return { isFile: true, isDirectory: false, size: data.length, mtimeMs: 1 };
    },
    async readdir(path) {
      calls.push(["readdir", path]);
      return [{ name: "a.txt", isDirectory: false, size: 5 }];
    },
    async exec(command, options) {
      calls.push(["exec", command, options]);
      options?.onData?.(Buffer.from("streamed"));
      return { exitCode: 0, stdout: "out", stderr: "", ...overrides.execResult };
    },
    ...overrides,
  };
  return { ws, calls, files };
}

test("read/write/edit adapters delegate and preserve provider errors", async () => {
  const { ws, calls } = fakeWorkspace();
  const read = toReadOperations(ws);
  assert.equal((await read.readFile("/ws/a.txt")).toString(), "hello");
  await read.access("/ws/a.txt");
  await assert.rejects(
    () => read.access("/ws/missing"),
    (error) => error.code === "NOT_FOUND",
  );

  const write = toWriteOperations(ws);
  await write.writeFile("/ws/a.txt", "next");
  await write.mkdir("/ws/sub");
  assert.deepEqual(calls.slice(0, 2), [
    ["readFile", "/ws/a.txt"],
    ["stat", "/ws/a.txt"],
  ]);
  assert.deepEqual(calls.at(-2), ["writeFile", "/ws/a.txt", "next"]);
  assert.deepEqual(calls.at(-1), ["mkdir", "/ws/sub"]);

  const edit = toEditOperations(ws);
  assert.equal((await edit.readFile("/ws/a.txt")).toString(), "next");
  await edit.writeFile("/ws/a.txt", "edited");
  await edit.access("/ws/a.txt");
});

test("ls adapter reports existence without swallowing non-NOT_FOUND errors", async () => {
  const { ws } = fakeWorkspace();
  const ls = toLsOperations(ws);
  assert.equal(await ls.exists("/ws/a.txt"), true);
  assert.equal(await ls.exists("/ws/missing"), false);
  assert.equal((await ls.stat("/ws")).isDirectory(), true);
  assert.deepEqual(await ls.readdir("/ws"), ["a.txt"]);

  const broken = fakeWorkspace({
    async stat() {
      throw new WorkspaceOperationError("EXEC_FAILED", "transport down");
    },
  });
  await assert.rejects(() => toLsOperations(broken.ws).exists("/ws/a.txt"), /transport down/);
});

test("bash adapter maps seconds, env and streaming to the provider", async () => {
  const { ws, calls } = fakeWorkspace();
  const bash = toBashOperations(ws);
  let streamed = "";
  const result = await bash.exec("echo hi", "/ws", {
    timeout: 12,
    env: { PI_MODEL: "m", UNSET: undefined },
    onData: (chunk) => {
      streamed += chunk.toString();
    },
  });
  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(streamed, "streamed");
  const [, command, options] = calls.at(-1);
  assert.equal(command, "echo hi");
  assert.equal(options.cwd, "/ws");
  assert.equal(options.timeout, 12);
  assert.deepEqual(options.env, { PI_MODEL: "m" });
});

test("capability failures are explicit", () => {
  const { ws } = fakeWorkspace({ capabilities: { read: true, write: false, exec: false } });
  assert.throws(
    () => toWriteOperations(ws),
    (error) => error.code === "READ_ONLY",
  );
  assert.throws(
    () => toEditOperations(ws),
    (error) => error.code === "READ_ONLY",
  );
  assert.throws(
    () => toBashOperations(ws),
    (error) => error.code === "READ_ONLY",
  );
});

test("workspace error exposes a stable code", () => {
  const error = new WorkspaceOperationError("OUT_OF_SCOPE", "nope");
  assert.equal(error.name, "WorkspaceOperationError");
  assert.equal(error.code, "OUT_OF_SCOPE");
});
