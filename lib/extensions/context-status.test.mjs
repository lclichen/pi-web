import assert from "node:assert/strict";
import test from "node:test";

/** context_status tool (feature-adoption #3) — now in the shared amedac-core
 *  package so the pi CLI gets it too; loaded here through the shim. */

async function loadSubject() {
  return import("./context-status.ts");
}

function makeCtx(usage) {
  return { getContextUsage: () => usage };
}

async function loadTool() {
  const mod = await loadSubject();
  const tools = [];
  const pi = { registerTool: (t) => tools.push(t) };
  mod.makeContextStatusExtension()(pi);
  return tools[0];
}

test("registers the read-only context_status tool with guidance", async () => {
  const tool = await loadTool();
  assert.equal(tool.name, "context_status");
  assert.ok(tool.promptSnippet.length > 0);
  assert.ok(tool.promptGuidelines.length >= 1);
  assert.deepEqual(tool.parameters.required ?? [], [], "no required params");
});

test("reports tokens, headroom, and a low-context warning at ≥80%", async () => {
  const tool = await loadTool();

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

test("registers via the amedac-core package entry too (CLI distribution path)", async () => {
  const mod = await import("../../pi-config/agent/extensions/amedac-core/index.ts");
  const tools = [];
  const pi = { registerTool: (t) => tools.push(t), registerCommand: () => {}, on: () => {}, appendEntry: () => {} };
  mod.default(pi);
  const names = tools.map((t) => t.name);
  for (const expected of ["todo", "plan_save", "enter_plan_mode", "exit_plan_mode", "context_status"]) {
    assert.ok(names.includes(expected), `${expected} must be registered by amedac-core`);
  }
});
