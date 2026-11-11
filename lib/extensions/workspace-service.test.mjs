import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { registerWorkspaceService } = await jiti.import("../extensions/workspace-service.ts");
const { WORKSPACE_REQUEST_EVENT, workspaceReplyEvent } = await jiti.import("../workspace-operations.ts");

function fakePi() {
  const listeners = new Map();
  const shutdown = [];
  const pi = {
    events: {
      emit(channel, data) {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
      on(channel, handler) {
        const list = listeners.get(channel) ?? [];
        list.push(handler);
        listeners.set(channel, list);
        return () => {
          listeners.set(
            channel,
            (listeners.get(channel) ?? []).filter((entry) => entry !== handler),
          );
        };
      },
    },
    on(event, handler) {
      if (event === "session_shutdown") shutdown.push(handler);
    },
  };
  return { pi, shutdown };
}

function request(pi, id, method, params) {
  return new Promise((resolve) => {
    const off = pi.events.on(workspaceReplyEvent(id), (body) => {
      off();
      resolve(body);
    });
    pi.events.emit(WORKSPACE_REQUEST_EVENT, { v: 1, id, method, params });
  });
}

function provider() {
  return {
    version: 1,
    root: "/workspace",
    capabilities: { read: true, write: true, exec: true },
    async canonicalize(path) {
      return path;
    },
    async readFile() {
      return Buffer.from("hello");
    },
    async writeFile() {},
    async mkdir() {},
    async stat() {
      return { isFile: true, isDirectory: false, size: 5, mtimeMs: 1 };
    },
    async readdir() {
      return [{ name: "a.txt", isDirectory: false, size: 5 }];
    },
    async exec(command) {
      return { exitCode: 0, stdout: `ran:${command}`, stderr: "" };
    },
  };
}

test("workspace bridge answers readFile as base64 and exec results", async () => {
  const { pi } = fakePi();
  registerWorkspaceService(pi, provider);

  const read = await request(pi, "r1", "readFile", { path: "/workspace/a.txt" });
  assert.equal(read.ok, true);
  assert.equal(Buffer.from(read.result, "base64").toString(), "hello");

  const exec = await request(pi, "r2", "exec", { command: "echo hi" });
  assert.deepEqual(exec, {
    v: 1,
    id: "r2",
    ok: true,
    result: { exitCode: 0, stdout: "ran:echo hi", stderr: "" },
  });
});

test("workspace bridge rejects unknown methods and malformed requests", async () => {
  const { pi } = fakePi();
  registerWorkspaceService(pi, provider);

  const unknown = await request(pi, "r3", "nope", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "UNSUPPORTED");

  const malformed = await new Promise((resolve) => {
    const off = pi.events.on(workspaceReplyEvent("r4"), (body) => {
      off();
      resolve(body);
    });
    pi.events.emit(WORKSPACE_REQUEST_EVENT, { id: "r4" });
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "UNSUPPORTED");
});

test("workspace bridge refuses oversized reads before transferring", async () => {
  const { pi } = fakePi();
  let reads = 0;
  const big = {
    ...provider(),
    async readFile() {
      reads += 1;
      return Buffer.alloc(0);
    },
    async stat() {
      return { isFile: true, isDirectory: false, size: 33 * 1024 * 1024, mtimeMs: 1 };
    },
  };
  registerWorkspaceService(pi, () => big);
  const reply = await request(pi, "r6", "readFile", { path: "/workspace/huge.bin" });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "UNSUPPORTED");
  assert.equal(reads, 0);
});

test("workspace bridge unregisters on session shutdown", async () => {
  const { pi, shutdown } = fakePi();
  registerWorkspaceService(pi, provider);
  assert.equal(shutdown.length, 1);
  shutdown[0]();
  await assert.rejects(
    () =>
      Promise.race([
        request(pi, "r5", "capabilities", {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30)),
      ]),
    /timeout/,
  );
});
