import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { default: workspaceProbeExtension } = await jiti.import(
  "../../builder-skills/pi-extension-dev/examples/workspace-probe/index.ts",
);

const REQUEST = "pi-web:workspace:request";
const REPLY_PREFIX = "pi-web:workspace:reply:";

function fakePi(responder) {
  const listeners = new Map();
  const tools = new Map();
  const pi = {
    events: {
      on(event, handler) {
        const list = listeners.get(event) ?? [];
        list.push(handler);
        listeners.set(event, list);
        return () =>
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((h) => h !== handler),
          );
      },
      emit(event, payload) {
        if (event === REQUEST) {
          const reply = responder(payload.method, payload.params);
          const handlers = listeners.get(`${REPLY_PREFIX}${payload.id}`) ?? [];
          for (const handler of handlers) handler({ v: 1, id: payload.id, ...reply });
          return;
        }
        for (const handler of listeners.get(event) ?? []) handler(payload);
      },
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  workspaceProbeExtension(pi);
  return tools;
}

test("example workspace_probe tool walks the v1 bridge and formats results", async () => {
  const calls = [];
  const tools = fakePi((method) => {
    calls.push(method);
    if (method === "capabilities") return { ok: true, result: { read: true, write: true, exec: true } };
    if (method === "stat") {
      return { ok: true, result: { isFile: true, isDirectory: false, size: 5, mtimeMs: 1 } };
    }
    if (method === "readFile") return { ok: true, result: Buffer.from("hello").toString("base64") };
    if (method === "exec") {
      return { ok: true, result: { exitCode: 0, stdout: "probe-ok\n", stderr: "" } };
    }
    return { ok: false, error: { code: "UNSUPPORTED", message: method } };
  });

  const result = await tools
    .get("workspace_probe")
    .execute("call-1", { path: "README.md", command: "echo probe-ok" }, undefined, undefined, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["capabilities", "stat", "readFile", "exec"]);
  assert.match(result.content[0].text, /"read": true/);
  assert.match(result.content[0].text, /hello/);
  assert.match(result.content[0].text, /probe-ok/);
  assert.equal(result.details.exec.exitCode, 0);
});

test("example workspace_probe tool surfaces bridge errors instead of guessing", async () => {
  const tools = fakePi((method) => {
    if (method === "capabilities") return { ok: true, result: { read: true, write: false, exec: false } };
    return { ok: false, error: { code: "OUT_OF_SCOPE", message: "Path escapes the workspace" } };
  });
  const result = await tools
    .get("workspace_probe")
    .execute("call-2", { path: "../etc/passwd" }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /OUT_OF_SCOPE/);
});
