import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("select options carry number badges with digit shortcuts (ZCode-style)", () => {
  // 数字快捷键：1-9 直接选择对应项（合成输入法期间不触发）。
  assert.match(source, /\/\^\[1-9\]\$\/\.test\(event\.key\) && !event\.nativeEvent\.isComposing/);
  // 徽章：前 9 项显示数字徽章（aria-hidden 装饰）。
  assert.match(source, /index < 9 && <span className="ext-select-badge" aria-hidden="true">\{index \+ 1\}<\/span>/);
  // 焦点态/徽章高亮由 CSS 类驱动（globals.css）。
  assert.match(cssSource, /\.ext-select-option:focus-visible \{/);
  assert.match(cssSource, /\.ext-select-option:focus-visible \.ext-select-badge \{/);
});

test("multi-line options split into label + description rows", () => {
  assert.match(source, /const lines = option\.split\("\\n"\)/);
  assert.match(source, /ext-select-label/);
  assert.match(source, /ext-select-desc/);
  // 单行选项保持整块 markdown 渲染（plan-mode 等既有用法不变）。
  assert.match(source, /<MarkdownBody>\{option\}<\/MarkdownBody>/);
});

test("footer shows keyboard hints for select and keeps the cancel button", () => {
  assert.match(source, /chat\.extensionSelectHint/);
  assert.match(source, /onRespond\(request, \{ cancelled: true \}\)/);
});
