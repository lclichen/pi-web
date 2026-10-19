import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  hashPrompt,
  countPromptTools,
  describePromptDrift,
  createPromptConsistencyExtension,
} = await import("jiti").then(({ createJiti }) => createJiti(import.meta.url).import("./prompt-consistency.ts"));

test("hashPrompt is deterministic and length-stable", () => {
  assert.equal(hashPrompt("abc"), hashPrompt("abc"));
  assert.notEqual(hashPrompt("abc"), hashPrompt("abd"));
  assert.equal(hashPrompt("abc").length, 12);
});

test("countPromptTools parses the Available tools section only", () => {
  const prompt = [
    "Identity line.",
    "",
    "Available tools:",
    "- read: Read files",
    "- bash: Run commands",
    "",
    "Guidelines:",
    "- guideline without tool prefix",
  ].join("\n");
  assert.equal(countPromptTools(prompt), 2);
  assert.equal(countPromptTools("no section"), -1);
});

test("drift attribution distinguishes tools/size/order changes", () => {
  assert.match(
    describePromptDrift({ hash: "a", len: 100, tools: 4 }, { hash: "b", len: 5000, tools: 105 }),
    /tools 4→105/,
  );
  assert.match(
    describePromptDrift({ hash: "a", len: 100, tools: 4 }, { hash: "b", len: 200, tools: 4 }),
    /same tool count, len 100→200/,
  );
  assert.match(
    describePromptDrift({ hash: "a", len: 100, tools: 4 }, { hash: "b", len: 100, tools: 4 }),
    /content\/order drifted/,
  );
});

test("pin extension reports and never rewrites the prompt", async () => {
  const seen = [];
  const ext = createPromptConsistencyExtension((hash, len, tools) => seen.push({ hash, len, tools }));
  const handlers = {};
  ext.factory({ on: (name, fn) => { handlers[name] = fn; } });
  const result = await handlers.before_agent_start({ systemPrompt: "Available tools:\n- read: x\n" });
  assert.equal(result, undefined, "pin extension must not modify the chained prompt");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tools, 1);
  assert.equal(seen[0].len, "Available tools:\n- read: x\n".length);
  assert.equal(seen[0].hash, hashPrompt("Available tools:\n- read: x\n"));
});

// 源码形状钉子：pin 扩展必须在两个装载臂的工厂数组末尾（before_agent_start
// 钩子顺序链式，末位看到最终合成提示词），并经 ref 回连 wrapper.observePrompt。
test("rpc-manager wires the pin extension at the tail of both loader arms", async () => {
  const src = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(src, /createPromptConsistencyExtension\(\(h, l, t\) => promptPinRef\.current\?\.\(h, l, t\)\),\s*\n\s*\],/s,
    "pin factory is the LAST entry of a loader arm's factories");
  const occurrences = src.match(/createPromptConsistencyExtension\(/g)?.length ?? 0;
  assert.equal(occurrences, 2, "exactly two arms carry the pin extension (quick + non-quick)");
  assert.match(src, /promptPinRef\.current = \(hash, len, tools\) => wrapper\.observePrompt\(hash, len, tools\)/,
    "pin reports route to wrapper.observePrompt");
  assert.match(src, /normalizeActiveToolOrder\(\): void/,
    "non-quick ordering normalization exists (send-time + restore path sort)");
});

test("session meta carries promptPin for cross-restart continuity", async () => {
  const metas = await readFile(new URL("./session-metas.ts", import.meta.url), "utf8");
  assert.match(metas, /promptPin\?: \{ hash: string; len: number; tools: number \}/,
    "SessionMeta.promptPin field exists");
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(rpc, /prompt drift on restore/, "restore-time drift warning exists");
  assert.match(rpc, /persistPromptPin/, "pin persists to the session meta store");
});
