import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { exportProjectConfigBundle } = await jiti.import("./project-config-bundle.ts");
const { inspectBundleZip } = await jiti.import("./bundle-inspect.ts");

/**
 * Demo assets guard (examples/agent-builder-demo): the shipped reference tree
 * must cover every module class the demo promises AND survive the real
 * export → inspect pipeline — 系统提示 / bundle.json 声明 / 技能+references /
 * 子代理 / 扩展 / MCP（模型不入包，见 agent-packaging 技能）。If a rename or
 * packaging-rule change breaks the demo, this test fails instead of the live demo.
 */

test("demo tree exports and inspects with every module class present", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-demo-"));
  try {
    cpSync(new URL("../examples/agent-builder-demo", import.meta.url), home, { recursive: true });

    const { bytes } = await exportProjectConfigBundle(home, "code-audit");
    const inspection = await inspectBundleZip(bytes);

    // 包声明 .pi/bundle.json → manifest.package（含依赖展示）
    assert.equal(inspection.package?.name, "code-audit");
    assert.equal(inspection.package?.version, "1.0.0");
    assert.deepEqual(inspection.dependencies, ["node>=20", "git"]);

    // 系统提示
    assert.ok(inspection.agentsMdBytes !== null && inspection.agentsMdBytes > 0);

    // 技能（含 references 渐进披露）
    const skillPaths = inspection.skills.map((s) => s.path).join("\n");
    assert.ok(skillPaths.includes(".pi/skills/code-audit-rules/SKILL.md"));
    assert.ok(skillPaths.includes(".pi/skills/code-audit-rules/references/checklist.md"));

    // 子代理 / 扩展 / MCP 服务器脚本
    const paths = [...inspection.extensions, ...inspection.agents, ...inspection.otherFiles]
      .map((f) => f.path)
      .concat(inspection.mcp.map((m) => m.file))
      .join("\n");
    assert.ok(paths.includes(".pi/agents/coverage-analyst.md"));
    assert.ok(paths.includes(".pi/extensions/audit-collect/index.js"));
    assert.ok(paths.includes(".pi/extensions/audit-collect/package.json"));
    assert.ok(paths.includes(".pi/mcp/memo-server.mjs"));
    assert.ok(paths.includes(".pi/mcp.json"));
    // 硬规则：包内不带 models.json（部署级配置，带错格式会清空会话模型列表）。
    assert.ok(!paths.includes(".pi/models.json"));
    assert.equal(inspection.counts.models, 0);
    assert.ok(paths.includes(".pi/bundle.json"));

    // 计数（inspect 分类）
    assert.equal(inspection.counts.agents, 1, "one subagent definition");
    assert.equal(inspection.counts.extensions, 2, "extension package.json + index.js");
    assert.equal(inspection.counts.mcp, 1, "mcp.json");
    assert.equal(inspection.counts.labs, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("export without a bundle.json declaration keeps the derived defaults", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-demo-plain-"));
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(home, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi/settings.json"), "{}", "utf8");
    const { bytes } = await exportProjectConfigBundle(home, "Plain Project");
    const inspection = await inspectBundleZip(bytes);
    assert.equal(inspection.package?.name, "Plain-Project");
    assert.equal(inspection.package?.version, "1.0.0");
    assert.deepEqual(inspection.dependencies, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
