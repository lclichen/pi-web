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

test("quick prompt rides the before_agent_start extension (loader options cannot reach the assembled base)", async () => {
  // 2026-10-13 三次修订（dev 实测）：resourceLoader 的 systemPromptOverride
  // 只作用于发现的 prompt 文件/customPrompt 输入、appendSystemPrompt 数组被
  // 当文件路径解析后过滤——都够不到装配后的基础段。提示词改写走
  // createQuickPromptExtension（before_agent_start，environment-info 同款
  // 钩子）；显示层由 wrapper 的 quickPrompt 镜像同一组合变换。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(src, /extensionFactories: \[createQuickPromptExtension\(quick\.systemPrompt\)\]/,
    "quick arm injects createQuickPromptExtension");
  assert.match(src, /quickPrompt: \{ template: quick\.systemPrompt \}/,
    "wrapper mirrors the composition for display (pre-turn get_state)");
  assert.match(src, /composeQuickSystemPrompt\(state\.systemPrompt, this\.quickPrompt\.template\)/,
    "display mirror uses composeQuickSystemPrompt");
});

test("restore rebuilds quick options from the persisted templateId", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./session-restore-options.ts", import.meta.url), "utf8");
  assert.match(src, /getQuickTemplate\(meta\.templateId\)/, "restore resolves the template by meta.templateId");
  assert.match(src, /quick: quickForRestore \?\? \{\}/, "restore passes quick options (toolset + prompt extension)");
  const metas = await readFile(new URL("./session-metas.ts", import.meta.url), "utf8");
  assert.match(metas, /templateId\?: string/, "SessionMeta carries templateId");
});

test("quick loader branch isolates context files and keeps the MCP surface", async () => {
  // 2026-10-13 修订钉子：quick 专属 resourceLoaderOptions 分支——
  //   noContextFiles（AGENTS.md 等绝不进 quick 提示词）、不设 systemPrompt
  //   占位符（会跳过工具列表装配）、不设 noExtensions（MCP 适配器必须加载）。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(src, /: quick[\s\S]{0,900}?noContextFiles: true/,
    "quick branch sets noContextFiles");
  const quickBranch = src.match(/: quick[\s\S]{0,1200}?appendSystemPromptOverride: \(\) => \[\],/)?.[0] ?? "";
  assert.ok(quickBranch.length > 0, "quick branch found up to the append override");
  assert.ok(!quickBranch.includes("noExtensions: true"), "noExtensions stays off (MCP adapter must load)");
  assert.ok(!/systemPrompt: quick/.test(quickBranch), "no systemPrompt placeholder (customPrompt path would skip tool docs)");
  const hooksSrc = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(hooksSrc, /\.\.\.\(newSessionModeRef\.current === "quick" \? \{\} : \{ cwd: newSessionCwd \}\)/,
    "ensure payload sends no cwd for quick");
});
