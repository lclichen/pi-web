import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const dialogSource = source.slice(source.indexOf("function ExtensionDialog"));
const customSource = source.slice(source.indexOf("function ExtensionCustomPanel"));

test("confines extension overlays to the content region above the composer", () => {
  assert.doesNotMatch(source, /function ExtensionRequestSheet/);
  assert.match(
    source,
    /className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"[\s\S]*?<ExtensionDialog[\s\S]*?<ExtensionCustomPanel[\s\S]*?className="relative shrink-0"[\s\S]*?{chatInputElement}/,
  );
  assert.match(dialogSource, /position: "absolute"[\s\S]*?inset: 0/);
  assert.match(dialogSource, /pointerEvents: "none"/);
  assert.match(dialogSource, /pointerEvents: "auto"/);
  assert.match(customSource, /position: "absolute"[\s\S]*?inset: 0/);
  assert.match(customSource, /pointerEvents: "none"/);
  assert.doesNotMatch(source, /z-\[100\]|zIndex: 100/);
  assert.match(customSource, /maxHeight: "min\(760px, 100%\)"/);
});

test("adds collapse without replacing cancel", () => {
  assert.match(dialogSource, /setCollapsed\(true\)/);
  assert.match(dialogSource, /chat\.extensionCollapse/);
  assert.match(dialogSource, /chat\.cancel/);
  assert.doesNotMatch(dialogSource, /chat\.extensionSkip/);
});

test("renders extension confirmation and options as markdown", () => {
  assert.match(source, /import \{ MarkdownBody, RemoteFileSessionContext \} from "\.\/MarkdownBody"/);
  assert.match(dialogSource, /<MarkdownBody>\{request\.message\}<\/MarkdownBody>/);
  // 单行选项按行内 markdown 渲染，去掉与徽章重复的序号前缀。
  assert.match(
    dialogSource,
    /role=\{editingCustom \? "group" : "button"\}[\s\S]*?data-extension-option[\s\S]*?<span className="ext-select-inline" inert[\s\S]*?<MarkdownBody>\{stripOptionOrdinal\(optionText, index\)\}<\/MarkdownBody>/,
  );
  assert.match(source, /function stripOptionOrdinal\(text: string, index: number\)/);
  assert.match(dialogSource, /aria-keyshortcuts=\{index < 9 \? String\(index \+ 1\) : undefined\}/);
  assert.doesNotMatch(dialogSource, /chat\.extensionSelectHint/);
  assert.doesNotMatch(dialogSource, /chat\.extensionRequest/);
  assert.match(
    dialogSource,
    /if \(index === 0 && element && !firstOptionFocused\.current && customEditIndex === null\)/,
  );
});

test("preserves title newlines like pi's TUI and keeps long titles from hiding the body", () => {
  const header = dialogSource.slice(
    dialogSource.indexOf('role="dialog"'),
    dialogSource.indexOf('{request.method === "confirm"'),
  );
  assert.match(header, /whiteSpace:\s+"pre-wrap",\s+overflowWrap:\s+"anywhere",?\s*\}\}\s*>\s*\{request\.title\}/);
  assert.match(
    header,
    /maxHeight:\s+"min\(40vh, 300px\)",\s+overflowY:\s+"auto",?\s*\}\}\s*>[\s\S]*?\{request\.title\}/,
  );
});

test("resets collapse state when a new extension request arrives", () => {
  assert.match(source, /<ExtensionDialog key=\{extensionDialog.id\}/);
  assert.match(source, /<ExtensionCustomPanel\s+key=\{extensionCustomUi.id\}/);
  assert.match(customSource, /if \(!collapsed\) inputRef.current\?\.focus\(\);\s*}, \[collapsed\]\)/);
});
