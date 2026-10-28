import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The store follows PI_WEB_DATA_DIR (lib/mode-homes.ts dataDir) — run in a
// temp data dir so the suite neither touches the repo's data/ nor other suites.
// 同时 chdir 到同一临时目录：让旧位置（<cwd>/data）不存在——否则套件首读会把
// 仓库的真实模板库当作旧位置数据迁移进来（行为正确，破坏测试隔离）。
const dir = mkdtempSync(join(tmpdir(), "pi-web-quick-templates-"));
const originalDataDir = process.env.PI_WEB_DATA_DIR;
const originalCwd = process.cwd();
process.env.PI_WEB_DATA_DIR = dir;
process.chdir(dir);
test.after(() => {
  if (originalDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
  else process.env.PI_WEB_DATA_DIR = originalDataDir;
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const { listQuickTemplates, createQuickTemplate, updateQuickTemplate, deleteQuickTemplate, DEFAULT_TEMPLATE_ID } =
  await import("jiti").then(({ createJiti }) => createJiti(import.meta.url).import("./quick-templates.ts"));

test("store follows PI_WEB_DATA_DIR instead of the process cwd (packaged-deploy data-dir conflict)", () => {
  // 回归钉子：storePath 曾硬编码 process.cwd()/data——打包部署落进包内只读
  // 目录，多用户共享一份包时互相冲突。现在必须写进 dataDir 覆盖值。
  //（不反证 cwd/data 未被写：dev 进程的 cwd/data 本就是合法数据目录。）
  const { template: tpl } = createQuickTemplate({ name: "path-probe", systemPrompt: "x" });
  const storeFile = join(dir, "quick-templates.json");
  assert.ok(existsSync(storeFile), "store file lives under PI_WEB_DATA_DIR");
  const onDisk = JSON.parse(readFileSync(storeFile, "utf8"));
  assert.ok(onDisk.templates.some((t) => t.id === tpl.id));
  deleteQuickTemplate(tpl.id);
});

test("one-time migration from the legacy cwd-relative location", () => {
  // 旧位置有数据、新位置为空 → 首次读取迁移归位（打包部署此前误写进包目录）。
  const legacyDir = mkdtempSync(join(tmpdir(), "pi-web-quick-templates-legacy-"));
  const legacyCwd = process.cwd();
  try {
    const legacyData = join(legacyDir, "data");
    mkdirSync(legacyData, { recursive: true });
    writeFileSync(
      join(legacyData, "quick-templates.json"),
      JSON.stringify({
        version: 1,
        templates: [{ id: "legacy-x", name: "旧模板", description: "", systemPrompt: "旧" }],
      }),
    );
    const freshDir = mkdtempSync(join(tmpdir(), "pi-web-quick-templates-fresh-"));
    process.chdir(legacyDir);
    const prevDataDir = process.env.PI_WEB_DATA_DIR;
    process.env.PI_WEB_DATA_DIR = freshDir;
    try {
      // 直接调内部读路径不可行（未导出）——经 listQuickTemplates 触发迁移读取。
      const templates = listQuickTemplates();
      assert.ok(
        templates.some((t) => t.id === "legacy-x"),
        "legacy template is read back",
      );
      assert.ok(existsSync(join(freshDir, "quick-templates.json")), "legacy store is copied into the data dir");
    } finally {
      process.env.PI_WEB_DATA_DIR = prevDataDir ?? "";
      if (!process.env.PI_WEB_DATA_DIR) delete process.env.PI_WEB_DATA_DIR;
      process.chdir(legacyCwd);
      rmSync(freshDir, { recursive: true, force: true });
    }
  } finally {
    process.chdir(legacyCwd);
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

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
  // 2026-10-16：同一钩子先重钳工具面（adapter 的 syncProxyTool 每回合可能
  // 把网关工具 mcp 加回活动集）。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /createQuickPromptExtension\(quickTemplateHolder!, \(\) => quickTurnClampRef\.current\?\.\(\)\)/,
    "quick arm injects createQuickPromptExtension with the per-turn tool clamp",
  );
  assert.match(
    src,
    /quickPrompt: quickTemplateHolder/,
    "wrapper mirrors the composition for display (pre-turn get_state)",
  );
  assert.match(
    src,
    /composeQuickSystemPrompt\(state\.systemPrompt, this\.quickPrompt\.current\)/,
    "display mirror uses composeQuickSystemPrompt",
  );
  // 封闭世界钳体：空名单 → 零工具；非空 → <server>_ 整段前缀匹配。
  assert.match(
    src,
    /setQuickToolAllowlist\(allowlist: string\[\] \| undefined\): void \{[\s\S]{0,600}?enforceQuickTools\(\)/,
    "allowlist is actually used (the 2026-10-16 leak was it being ignored)",
  );
  assert.match(
    src,
    /startsWith\(server \+ "_"\)/,
    "prefix match is whole-segment (underscore-containing server names like mcd_tool_1)",
  );
});

test("quick closed world: empty allowlist means zero tools, template switch re-applies it", async () => {
  // 2026-10-16 泄漏回归钉子：setQuickToolAllowlist 忽略白名单入参 → 全局
  // MCP 服务器（经 adapter 的 earlyConfig/direct-tools 注册路径）全部漏进
  // 快速会话。三处必须保持：钳体用白名单；切模板重挂；set_tools 钳制。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /apply_quick_template[\s\S]{0,900}?this\.setQuickToolAllowlist\(template\.mcpServers\)/,
    "apply_quick_template re-applies the new template's allowlist",
  );
  assert.match(
    src,
    /setActiveToolSelection\(toolNames: string\[\]\): void \{[\s\S]{0,700}?quickToolSet\(this\.inner, this\.quickToolAllowlist\)/,
    "user tool selection is clamped to the closed world in quick sessions",
  );
  const quickSession = await readFile(new URL("./quick-session.ts", import.meta.url), "utf8");
  assert.match(
    quickSession,
    /disableProxyTool: true/,
    "workspace config suppresses the adapter gateway tool at the source",
  );
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
  assert.match(src, /: quick[\s\S]{0,900}?noContextFiles: true/, "quick branch sets noContextFiles");
  const quickBranch = src.match(/: quick[\s\S]{0,1200}?appendSystemPromptOverride: \(\) => \[\],/)?.[0] ?? "";
  assert.ok(quickBranch.length > 0, "quick branch found up to the append override");
  assert.ok(!quickBranch.includes("noExtensions: true"), "noExtensions stays off (MCP adapter must load)");
  assert.ok(
    !/systemPrompt: quick/.test(quickBranch),
    "no systemPrompt placeholder (customPrompt path would skip tool docs)",
  );
  const hooksSrc = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(
    hooksSrc,
    /cwd: newSessionCwd \?\? undefined/,
    "ensure payload sends cwd for all modes incl. quick (workspace path from /api/quick-workspace)",
  );
});
