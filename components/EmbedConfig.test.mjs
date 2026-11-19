import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./EmbedConfig.tsx", import.meta.url), "utf8");

test("keeps product configuration admin-only", () => {
  assert.match(source, /if \(!isAdmin\)/);
  assert.match(source, /fetch\("\/api\/admin\/embed-profiles"/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /allowedCommands/);
  assert.match(source, /allowedOrigins/);
});

test("edits the product user group, fixed bundle, and default mode", () => {
  assert.match(source, /embed\.members/);
  assert.match(source, /members: \[\.\.\.members, user\.id\]/);
  assert.match(source, /fetch\(`\/api\/admin\/users\?search=/);
  assert.match(source, /embed\.configBundle/);
  assert.match(source, /embed\.defaultMode/);
  assert.match(source, /\/api\/bundles/);
});

test("does not expose legacy token links anymore", () => {
  assert.doesNotMatch(source, /\/api\/embed\/tokens/);
  assert.doesNotMatch(source, /embed\.tokens/);
  assert.doesNotMatch(source, /copyLink/);
});

test("product rows keep stable React keys independent of the product id", () => {
  // 行 key 与产品 id 解耦：编辑某行 ID 不触发该行重挂载（输入框丢焦点），
  // 删除一行后其余行的 key 也不变。
  assert.match(source, /function createRowKey\(\)/);
  assert.match(source, /const \[rowKeys, setRowKeys\] = useState<string\[\]>\(\[\]\)/);
  assert.match(source, /key=\{rowKeys\[index\] \?\? `row-\$\{index\}`\}/);
  assert.doesNotMatch(source, /key=\{index\}/);
  // 新增行生成新 key；删除行按 index 过滤 key；服务端整体重载时重新生成
  assert.match(source, /setRowKeys\(\(current\) => \[\.\.\.current, createRowKey\(\)\]\)/);
  assert.match(source, /setRowKeys\(\(current\) => current\.filter\(\(_, i\) => i !== index\)\)/);
  assert.match(source, /setRowKeys\(\((profileData\.products|data\.products) \?\? \[\]\)\.map\(\(\) => createRowKey\(\)\)\)/);
  // 行 key 只用于渲染，保存仍提交纯 profile 数组
  assert.match(source, /body: JSON\.stringify\(\{ products \}\)/);
});
