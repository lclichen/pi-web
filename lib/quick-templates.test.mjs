import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The store reads/writes <cwd>/data/quick-templates.json — run in a temp cwd.
const dir = mkdtempSync(join(tmpdir(), "pi-web-quick-templates-"));
const originalCwd = process.cwd();
process.chdir(dir);
test.after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const {
  listQuickTemplates,
  createQuickTemplate,
  updateQuickTemplate,
  deleteQuickTemplate,
  DEFAULT_TEMPLATE_ID,
} = await import("jiti").then(({ createJiti }) => createJiti(import.meta.url).import("./quick-templates.ts"));

test("seeds the editable, undeletable default template", () => {
  const templates = listQuickTemplates();
  assert.equal(templates.length, 1);
  const def = templates[0];
  assert.equal(def.id, DEFAULT_TEMPLATE_ID);
  assert.equal(def.builtin, true);
  assert.ok(def.systemPrompt.includes("快速会话"));
  assert.match(def.systemPrompt, /不能执行命令|不能读写文件/);
});

test("creates and lists custom templates; validation rejects bad input", () => {
  const ok = createQuickTemplate({ name: "产品A助手", description: "A 产品问答", systemPrompt: "你是产品A助手" });
  assert.ok(ok.template);
  assert.equal(listQuickTemplates().length, 2);

  const noName = createQuickTemplate({ systemPrompt: "x" });
  assert.ok(noName.errors?.some((e) => e.field === "name"));

  const badModel = createQuickTemplate({ name: "m", systemPrompt: "x", model: { provider: "" } });
  assert.ok(badModel.errors?.some((e) => e.field === "model"));
});

test("MCP allowlist is normalized to trimmed non-empty strings", () => {
  const r = createQuickTemplate({ name: "restricted", systemPrompt: "x", mcpServers: [" weather ", "", "db"] });
  assert.deepEqual(r.template.mcpServers, ["weather", "db"]);
});

test("updates merge and keep builtin flag; model can be cleared", () => {
  const updated = updateQuickTemplate(DEFAULT_TEMPLATE_ID, { name: "快速会话（新）", systemPrompt: "新提示词" });
  assert.equal(updated.template.name, "快速会话（新）");
  assert.equal(updated.template.builtin, true);

  const cleared = updateQuickTemplate(r2().id, { model: undefined, mcpServers: [] });
  assert.equal(cleared.template.model, undefined);
  assert.deepEqual(cleared.template.mcpServers, []);

  function r2() {
    return listQuickTemplates().find((t) => t.name === "restricted");
  }
});

test("default template refuses deletion; custom ones delete fine", () => {
  const refused = deleteQuickTemplate(DEFAULT_TEMPLATE_ID);
  assert.equal(refused.ok, false);

  const custom = listQuickTemplates().find((t) => !t.builtin);
  const done = deleteQuickTemplate(custom.id);
  assert.equal(done.ok, true);
  assert.equal(listQuickTemplates().length, 2); // default + one remaining custom
});

test("quick template system prompt rides the append path (AGENTS.md-like), not exact replacement", async () => {
  // 2026-10-13 修订：模板"系统提示词"此前经 exactSystemPrompt 全量替换，
  // 而该猴子补丁路径在 RPC 回合中实际未生效（内容从未到达模型）。现改为
  // resourceLoaderOptions.appendSystemPrompt 附加——pi 基础提示词 + 活动
  // 工具说明（含 MCP 工具文档，与普通会话一致）之后附加模板内容；quick
  // 同时获得 Web 输出附加段。钉住这三点。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(src, /quick\?\.systemPrompt \? \{ appendSystemPrompt: \[quick\.systemPrompt\] \}/,
    "quick systemPrompt wired via appendSystemPrompt");
  assert.ok(!src.includes("quick?.systemPrompt\n        ? () => quick.systemPrompt")
    && !src.includes("quick?.systemPrompt\r\n        ? () => quick.systemPrompt"),
    "exact replacement no longer used for quick");
  assert.match(src, /webUiPrompt: !subagentResources,/,
    "quick sessions get the web output addendum");
});

test("quick sessions adapt the base prompt via the official override hook", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(src, /systemPromptOverride: \(base: string \| undefined\) => \(typeof base === "string" \? adaptQuickBasePrompt\(base\) : base\)/,
    "quick base prompt runs through adaptQuickBasePrompt (identity swap + docs block removal)");
  assert.ok(!src.includes('new Set(["todo", "plan_save"])'),
    "quick toolset no longer includes todo/plan_save (MCP-only)");
});
