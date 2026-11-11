import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { makeRelayToolsExtension } = await jiti.import("./relay-tools.ts");
const { makeSshToolsExtension } = await jiti.import("./ssh-tools.ts");
const { makeHostWorkspaceServiceExtension } = await jiti.import("./host-workspace.ts");
const { WORKSPACE_REQUEST_EVENT, workspaceReplyEvent } = await jiti.import("../workspace-operations.ts");

function fakePi() {
  const handlers = new Map();
  const shutdown = [];
  return {
    pi: {
      events: {
        emit(channel, data) {
          for (const handler of handlers.get(channel) ?? []) handler(data);
        },
        on(channel, handler) {
          const list = handlers.get(channel) ?? [];
          list.push(handler);
          handlers.set(channel, list);
          return () =>
            handlers.set(
              channel,
              (handlers.get(channel) ?? []).filter((h) => h !== handler),
            );
        },
      },
      registerTool() {},
      registerCommand() {},
      registerFlag() {},
      on(event, handler) {
        if (event === "session_shutdown") shutdown.push(handler);
      },
    },
    shutdown,
  };
}

function capabilities(pi) {
  return new Promise((resolve) => {
    const off = pi.events.on(workspaceReplyEvent("caps"), (body) => {
      off();
      resolve(body);
    });
    pi.events.emit(WORKSPACE_REQUEST_EVENT, { v: 1, id: "caps", method: "capabilities" });
  });
}

test("relay, SSH and host extensions register the workspace bridge", async () => {
  for (const register of [
    (pi) => makeRelayToolsExtension(1).factory(pi),
    (pi) => makeSshToolsExtension({ projectId: "p", sshConfig: {}, workdir: "/" })(pi),
  ]) {
    const { pi } = fakePi();
    register(pi);
    const reply = await capabilities(pi);
    assert.equal(reply.ok, true);
    assert.equal(reply.result.read, true);
    assert.equal(reply.result.exec, true);
  }

  const { pi } = fakePi();
  makeHostWorkspaceServiceExtension("/tmp").factory(pi);
  const reply = await capabilities(pi);
  assert.equal(reply.ok, true);
  assert.equal(reply.result.read, true);
});

test("sandbox extension source registers the same bridge", async () => {
  const source = await readFile(
    new URL("../../pi-config/agent/extensions/amedac-core/src/sandbox/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /registerWorkspaceService\(pi/);
  assert.match(source, /createSandboxWorkspaceOperations/);
});

test("host/quick/restore/subagent/batch entry points inject the host workspace service", async () => {
  const files = [
    "../../app/api/agent/new/route.ts",
    "../session-restore-options.ts",
    "../subagent-bridge.ts",
    "../batch/task-runner.ts",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes("makeHostWorkspaceServiceExtension"), file);
  }
});
