import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./McpServersConfig.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

/**
 * MCP 面板回归点（用户实测）：
 *  · 详情页开关必须发 PATCH（曾因 key 拼接/空实现看起来“没反应”）；
 *  · 默认写项目级覆盖，不能把全局服务器整个禁掉；
 *  · 源码不得再出现裸 NUL 字节（MCP 的 scope\0name key）。
 */

test("server keys use one escaped helper and contain no raw NUL bytes", () => {
  assert.equal(source.includes("\0"), false, "source must not embed literal NUL bytes");
  assert.match(
    source,
    /function serverKey\(scope: ConfigScope, name: string\): string \{\s*return `\$\{scope\}\\0\$\{name\}`;/,
  );
  assert.match(source, /serverKey\(x\.scope, x\.name\) === selectedKey/);
});

test("detail switch PATCHes the workspace override by default", () => {
  const toggle = source.slice(source.indexOf("const setServerEnabled"), source.indexOf("const setGroupEnabled"));
  assert.match(toggle, /method: "PATCH"/);
  assert.match(toggle, /target: "project"/);
  assert.match(toggle, /scope: srv\.scope/);
  assert.match(source, /scopeEnableBlocked/);
  assert.match(source, /selectedSrv\?\.projectOverride/);
});

test("saving a global/quick entry never absorbs the workspace-override state", () => {
  assert.match(source, /form\.scope === "project" \? form\.disabled : form\.scopeDisabled/);
  assert.match(source, /mcp\.scopeDisabledGlobal/);
  assert.match(source, /mcp\.scopeDisabledQuick/);
  assert.match(source, /scopeReadOnly/);
});

test("settings panel passes the admin flag to the MCP section", () => {
  assert.match(panelSource, /<McpServersConfig[^>]*isAdmin=\{isAdmin\}/);
});
