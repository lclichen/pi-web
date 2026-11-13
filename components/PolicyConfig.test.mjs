import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PolicyConfig.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

test("policy settings split path and tool guardrails into sub-tabs", () => {
  assert.match(source, /const \[tab, setTab\] = useState<"path" \| "tools">\("path"\)/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /{t\("policy\.pathTitle"\)}/);
  assert.match(source, /{t\("policy\.toolsTitle"\)}/);

  const pathPanel = source.slice(source.indexOf('id="policy-panel-path"'), source.indexOf('id="policy-panel-tools"'));
  const toolsPanel = source.slice(source.indexOf('id="policy-panel-tools"'));
  assert.match(pathPanel, /policy\.intro/);
  assert.match(pathPanel, /policy\.allowWrite/);
  assert.match(pathPanel, /policy\.decisions/);
  assert.doesNotMatch(pathPanel, /policy\.toolsColTool/);

  assert.match(toolsPanel, /policy\.toolsColTool/);
  assert.match(toolsPanel, /policy\.toolsMcp/);
  assert.match(toolsPanel, /policy\.toolsMcpHint/);

  // 工具视图有自己的加载失败提示，不再依赖路径状态的错误位。
  assert.match(source, /setToolError/);
  // 子标签沿用设置资源页的 tab 视觉。
  assert.match(css, /\.policy-subtab\.is-active/);
});
