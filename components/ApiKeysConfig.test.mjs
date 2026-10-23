import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ApiKeysConfig.tsx", import.meta.url), "utf8");
const quickSource = await readFile(new URL("./QuickTemplatesConfig.tsx", import.meta.url), "utf8");

test("hiding a freshly created key works (revealNew does not pin the plaintext)", () => {
  // 回显状态由 revealed 集合唯一驱动；toggleReveal 必须同时清 revealNew，
  // 否则新建密钥点“隐藏”不生效（历史 bug）。
  assert.doesNotMatch(source, /revealNew === row\.id/);
  assert.match(source, /setRevealNew\(\(current\) => \(current === id \? null : current\)\)/);
  assert.match(source, /const isRevealed = revealed\.has\(row\.id\)/);
});

test("uses the styled confirm dialog instead of window.confirm", () => {
  assert.doesNotMatch(source, /window\.confirm/);
  assert.doesNotMatch(quickSource, /window\.confirm/);
  assert.match(source, /useConfirm\(\)/);
  assert.match(quickSource, /useConfirm\(\)/);
});

test("revoke uses the danger button variant and theme tokens", () => {
  assert.match(source, /variant="danger" size="small" disabled=\{revoking !== null\}/);
  assert.doesNotMatch(source, /#f87171/);
  assert.doesNotMatch(source, /#22c55e/);
});

test("quick templates register dirty state and guard draft switches", () => {
  assert.match(quickSource, /registerSettingsDirty\("quick-templates"/);
  assert.match(quickSource, /isDraftDirty\(creating, draft, selected\)/);
  assert.match(quickSource, /discardDraftTitle/);
});

test("separates manual, auto (login session), and external keys", () => {
  // 服务端按命名约定（pi-web YYYY-MM-DD）+ 在册状态分类，客户端分组渲染。
  assert.match(source, /groupOf\(row\)/);
  assert.match(source, /apiKeys\.groupManual/);
  assert.match(source, /apiKeys\.groupAuto/);
  assert.match(source, /apiKeys\.groupExternal/);
  // 登录会话密钥组默认折叠。
  assert.match(source, /useState\(false\)[\s\S]*?autoExpanded/);
  assert.match(source, /aria-expanded=\{autoExpanded\}/);
  // 当前会话密钥带标记（吊销会立即下线本会话）。
  assert.match(source, /row\.isCurrent/);
  assert.match(source, /apiKeys\.currentSession/);
});
