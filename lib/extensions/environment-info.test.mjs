import assert from "node:assert/strict";
import test from "node:test";

/** Environment prompt block only — the portable context_status tool moved to
 *  the shared amedac-core package (see context-status.test.mjs). */

async function loadSubject() {
  return import("./environment-info.ts");
}

async function loadExtension(info) {
  const mod = await loadSubject();
  const handlers = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
  mod.makeEnvironmentInfoExtension(info)(pi);
  return { handlers };
}

test("environment block rides the system prompt (sentinel-delimited, idempotent)", async () => {
  const { handlers } = await loadExtension({ mode: "ssh", username: "ops" });
  const inject = handlers.get("before_agent_start")[0];
  const first = await inject({ systemPrompt: "BASE" });
  assert.match(first.systemPrompt, /PI_WEB_ENV_BEGIN/);
  assert.match(first.systemPrompt, /远程主机/);
  // Re-injecting over an already-injected prompt replaces, not duplicates.
  const second = await inject({ systemPrompt: first.systemPrompt });
  assert.equal(second.systemPrompt.match(/PI_WEB_ENV_BEGIN/g).length, 1);
});

test("registers no tools of its own anymore", async () => {
  const mod = await loadSubject();
  const tools = [];
  const pi = { on: () => {}, registerTool: (t) => tools.push(t) };
  mod.makeEnvironmentInfoExtension({ mode: "host", username: "admin" })(pi);
  assert.deepEqual(tools, []);
});
