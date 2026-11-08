import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("select options carry number badges with digit shortcuts (ZCode-style)", () => {
  // 数字快捷键：1-9 直接选择对应项（合成输入法期间不触发）。
  assert.match(source, /\/\^\[1-9\]\$\/\.test\(event\.key\) && !event\.nativeEvent\.isComposing/);
  // 徽章：前 9 项显示数字徽章（aria-hidden 装饰）。
  assert.match(
    source,
    /index\s+<\s+9\s+&&\s+\(\s*<span\s+className="ext-select-badge"\s+aria-hidden="true">\s*\{index\s+\+\s+1\}\s*<\/span>/,
  );
  // 焦点态/徽章高亮由 CSS 类驱动（globals.css）。
  assert.match(cssSource, /\.ext-select-option:focus-visible \{/);
  assert.match(cssSource, /\.ext-select-option:focus-visible \.ext-select-badge \{/);
});

test("multi-line options split into label + description rows", () => {
  assert.match(source, /const lines = optionText\.split\("\\n"\)/);
  assert.match(source, /ext-select-label/);
  assert.match(source, /ext-select-desc/);
  // 单行选项保持整块 markdown 渲染（plan-mode 等既有用法不变）。
  assert.match(source, /<MarkdownBody>\{customDisplay \?\? stripOptionOrdinal\(optionText, index\)\}<\/MarkdownBody>/);
});

test("footer keeps cancel without the always-visible shortcut paragraph", () => {
  assert.doesNotMatch(source, /chat\.extensionSelectHint/);
  assert.match(source, /aria-keyshortcuts=\{index < 9 \? String\(index \+ 1\) : undefined\}/);
  assert.match(source, /onRespond\(request, \{ cancelled: true \}\)/);
});

test("custom answer row expands into an inline editor (ZCode-style)", () => {
  assert.match(source, /const CUSTOM_OPTION_MARKER = "\\u2063"/);
  assert.match(source, /function splitCustomOption\(option: string\)/);
  assert.match(source, /className="ext-select-custom-input"/);
  assert.match(source, /placeholder=\{t\("chat\.extensionCustomPlaceholder"\)\}/);
  assert.match(source, /onRespond\(request, \{ value: `\$\{CUSTOM_OPTION_MARKER\}\$\{text\}` \}\)/);
  // Esc closes only the inline editor and returns focus to the row.
  assert.match(source, /setCustomEditIndex\(null\);[\s\S]{0,160}customRowRef\.current\?\.focus\(\)/);
});

test("multi-select renders checkbox rows with a confirm action", () => {
  assert.match(source, /request\.multiSelect === true/);
  assert.match(source, /const MULTI_SELECT_RESPONSE_MARKER = "\\u2062"/);
  assert.match(source, /role=\{editingCustom \? "group" : isMultiSelect && !isCustom \? "checkbox" : "button"\}/);
  assert.match(source, /aria-checked=\{isMultiSelect && !isCustom \? checked : undefined\}/);
  assert.match(source, /className=\{`ext-select-check\$\{checked \? " is-checked" : ""\}`\}/);
  assert.match(source, /onClick=\{submitMulti\}/);
  assert.match(source, /t\("chat\.confirm"\)/);
  assert.match(cssSource, /\.ext-select-check\.is-checked \{/);
});
