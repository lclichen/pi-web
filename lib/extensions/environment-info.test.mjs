import assert from "node:assert/strict";
import test from "node:test";

/** context_status tool (feature-adoption #3) + env-info prompt block. */

async function loadSubject() {
  return import("./environment-info.ts");
}

function makeCtx(usage) {
  return {
    getContextUsage: () => usage,
  };
}

async function loadExtension(info) {
  const mod = await loadSubject();
  const tools = [];
  const handlers = new Map();
  const pi = {
    registerTool: (t) => tools.push(t),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
  mod.makeEnvironmentInfoExtension(info)(pi);
  return { tools, handlers };
}

test("registers the read-only context_status tool with guidance", async () => {
  const { tools } = await loadExtension({ mode: "host", username: "admin" });
  const tool = tools.find((t) => t.name === "context_status");
  assert.ok(tool, "context_status must be registered");
  assert.ok(tool.promptSnippet.length > 0);
  assert.ok(tool.promptGuidelines.length >= 1);
  assert.deepEqual(tool.parameters.required ?? [], [], "no required params");
});

test("context_status reports tokens, headroom, and a low-context warning at ≥80%", async () => {
  const { tools } = await loadExtension({ mode: "sandbox", username: "u1", containerId: 7 });
  const tool = tools.find((t) => t.name === "context_status");

  const ok = await tool.execute("t", {}, undefined, undefined, makeCtx({ tokens: 10_000, contextWindow: 100_000, percent: 10 }));
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /10,000 \/ 100,000 tokens/);
  assert.match(ok.content[0].text, /90,000 tokens headroom/);
  assert.ok(!/LOW/.test(ok.content[0].text));
  assert.equal(ok.details.known, true);
  assert.equal(ok.details.remaining, 90_000);

  const low = await tool.execute("t", {}, undefined, undefined, makeCtx({ tokens: 85_000, contextWindow: 100_000, percent: 85 }));
  assert.match(low.content[0].text, /Headroom is LOW/);
  assert.match(low.content[0].text, /persist key findings/);

  const unknown = await tool.execute("t", {}, undefined, undefined, makeCtx({ tokens: null, contextWindow: 100_000, percent: null }));
  assert.equal(unknown.details.known, false);
  assert.match(unknown.content[0].text, /unknown/i);
});

test("environment block still rides the system prompt (sentinel-delimited, idempotent)", async () => {
  const { handlers } = await loadExtension({ mode: "ssh", username: "ops" });
  const inject = handlers.get("before_agent_start")[0];
  const first = await inject({ systemPrompt: "BASE" });
  assert.match(first.systemPrompt, /PI_WEB_ENV_BEGIN/);
  assert.match(first.systemPrompt, /远程主机/);
  // Re-injecting over an already-injected prompt replaces, not duplicates.
  const second = await inject({ systemPrompt: first.systemPrompt });
  assert.equal(second.systemPrompt.match(/PI_WEB_ENV_BEGIN/g).length, 1);
});
