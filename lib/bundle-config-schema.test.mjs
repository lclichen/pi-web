import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { validateMcpConfigText, validateModelsConfigText, validateBundleConfigText } =
  await jiti.import("./bundle-config-schema.ts");
const { exportProjectConfigBundle } = await jiti.import("./project-config-bundle.ts");

/**
 * mcp.json / models.json 是"格式很严格"的文件：pi 与 pi-mcp-adapter 按固定
 * 结构读取，格式错了会话直接起不来（典型：旧 demo 的 { modelList: [] } 会让
 * 项目模型列表变空）。导出/导入前必须拒绝，而不是发一个装得下但跑不起来的包。
 */

test("mcp.json: accepts the adapter's documented shapes", () => {
  const ok = JSON.stringify({
    mcpServers: {
      stdio: { command: "npx", args: ["-y", "srv"], env: { KEY: "v" } },
      http: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" }, auth: "bearer" },
      off: { command: "node", args: ["s.js"], disabled: true, directTools: ["a", "b"] },
      full: {
        command: "node",
        lifecycle: "keep-alive",
        idleTimeout: 30,
        requestTimeoutMs: 30000,
        includeTools: ["x"],
        excludeTools: ["y"],
        transport: "stdio",
      },
      empty: {},
    },
  });
  // `empty` has no command/url on purpose → one problem, everything else fine.
  const problems = validateMcpConfigText(ok);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /empty.*command/);
});

test("mcp.json: rejects broken structure with actionable messages", () => {
  assert.match(validateMcpConfigText("{ not json")[0], /不是合法 JSON/);
  assert.match(validateMcpConfigText("[]")[0], /根节点必须是对象/);
  assert.match(validateMcpConfigText("{}")[0], /缺少 mcpServers/);
  const bad = validateMcpConfigText(
    JSON.stringify({
      mcpServers: {
        a: { command: "node", args: "nope", env: { X: 1 }, disabled: "yes", auth: "basic" },
      },
    }),
  );
  assert.ok(bad.some((p) => /\.args 必须是字符串数组/.test(p)));
  assert.ok(bad.some((p) => /\.env 必须是 KEY→字符串/.test(p)));
  assert.ok(bad.some((p) => /\.disabled 必须是布尔值/.test(p)));
  assert.ok(bad.some((p) => /\.auth 只能是 none \/ bearer \/ oauth/.test(p)));
});

test("models.json: accepts pi's providers format, rejects the legacy modelList shape", () => {
  const ok = JSON.stringify({
    providers: {
      gateway: {
        api: "openai-completions",
        baseUrl: "http://host/v1",
        apiKey: "k",
        models: [{ id: "qwen", contextWindow: 200000, cost: { input: 0, output: 0 } }],
      },
    },
  });
  assert.deepEqual(validateModelsConfigText(ok), []);

  const legacy = JSON.stringify({ modelList: [{ id: "deepseek" }] });
  const problems = validateModelsConfigText(legacy);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /旧格式 modelList/);

  const broken = validateModelsConfigText(JSON.stringify({ providers: { p: { models: [{ name: "x" }] } } }));
  assert.ok(broken.some((p) => /providers\.p\.models\[0\]\.id/.test(p)));
});

test("validateBundleConfigText only judges config files", () => {
  assert.deepEqual(validateBundleConfigText(".pi/skills/a/SKILL.md", "not json"), []);
  assert.ok(validateBundleConfigText(".pi/mcp.json", "{}").length > 0);
  assert.ok(validateBundleConfigText(".pi/models.json", "{}").length > 0);
});

test("export refuses a project whose models.json uses the legacy shape", async () => {
  const home = mkdtempSync(join(tmpdir(), "bundle-schema-"));
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "models.json"), JSON.stringify({ modelList: [{ id: "x" }] }), "utf8");
  await assert.rejects(() => exportProjectConfigBundle(home, "legacy"), /导出中止.*旧格式 modelList/);
});
