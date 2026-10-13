import assert from "node:assert/strict";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * 快速会话基础提示词适配（lib/quick-prompt.ts）的防漂移测试：
 * 用**真实安装的 SDK**（node_modules 里的 buildSystemPrompt）按 quick 的
 * 工具面（MCP-only）构建基础提示词，再断言适配结果。上游 pi 一旦改写
 * 身份段或文档块的措辞，这里的断言就会红——更新 QUICK_IDENTITY_ORIGINAL /
 * DOCS_BLOCK_* 锚点即可，这正是本测试存在的目的。
 */

// 与 rpc-manager quickToolSet 的产物同形：MCP-only（quick 不再带 todo/plan）。
const QUICK_LIKE_TOOLS = ["weather_get-forecast", "db-query_run-sql"];

async function buildRealQuickBase() {
  const { buildSystemPrompt } = await jiti.import(
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js",
  );
  return buildSystemPrompt({
    selectedTools: QUICK_LIKE_TOOLS,
    toolSnippets: Object.fromEntries(QUICK_LIKE_TOOLS.map((t) => [t, `${t} one-line description`])),
    promptGuidelines: [],
    cwd: "/srv/quick/u1",
  });
}

test("real SDK base prompt: identity swapped, pi-docs block removed, the rest preserved", async () => {
  const { adaptQuickBasePrompt, quickPromptAdaptationReport, QUICK_IDENTITY_REPLACEMENT } =
    await jiti.import("./quick-prompt.ts");
  const base = await buildRealQuickBase();

  // 前提：真实基础提示词确实还带着两段瑕疵（若此处红=上游已改，锚点需更新）
  assert.ok(base.includes("Pi documentation"), "precondition: upstream still ships the docs block");
  assert.ok(
    base.includes("expert coding assistant"),
    "precondition: upstream still ships the coding identity paragraph",
  );

  const adapted = adaptQuickBasePrompt(base);
  const report = quickPromptAdaptationReport(adapted);
  assert.deepEqual(report, { identityReplaced: true, docsRemoved: true });

  // 身份段换成 quick 语义，原句消失
  assert.ok(adapted.includes(QUICK_IDENTITY_REPLACEMENT));
  assert.ok(!adapted.includes("expert coding assistant"));

  // 文档块整段消失
  assert.ok(!adapted.includes("Pi documentation"));
  assert.ok(!adapted.includes("tui.md"));

  // 其余构成保留：工具一行列表、准则、cwd 行
  for (const tool of QUICK_LIKE_TOOLS) assert.ok(adapted.includes(tool), `tool listed: ${tool}`);
  assert.ok(adapted.includes("Be concise in your responses"), "guidelines kept");
  assert.ok(adapted.includes("Current working directory:"), "cwd line kept");
});

test("adaptation is a no-op on an already-adapted prompt (idempotent)", async () => {
  const { adaptQuickBasePrompt } = await jiti.import("./quick-prompt.ts");
  const base = await buildRealQuickBase();
  const once = adaptQuickBasePrompt(base);
  assert.equal(adaptQuickBasePrompt(once), once);
});

test("anchors missing from the input leave it untouched (no guessing)", async () => {
  const { adaptQuickBasePrompt } = await jiti.import("./quick-prompt.ts");
  const unrelated = "Some other harness prompt entirely.\nAvailable tools:\n- x: thing\n";
  assert.equal(adaptQuickBasePrompt(unrelated), unrelated);
});
