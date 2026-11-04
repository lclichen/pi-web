import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_DOCS_BLOCK_END,
  PI_DOCS_BLOCK_START,
  stripPiDocumentationBlock,
  stripWorkingDirectoryLine,
} from "./prompt-sections.ts";

/** SDK 基础提示词的真实形状（节选）：Guidelines → Pi documentation 块 →
 *  末尾 Current working directory 行。 */
const BASE = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "",
  "Guidelines:",
  "- Be concise in your responses",
  "",
  `${PI_DOCS_BLOCK_START} about pi itself, its SDK, extensions, themes, skills, or TUI):`,
  "- Main documentation: /opt/pi/README.md",
  "- Additional docs: /opt/pi/docs",
  "- Examples: /opt/pi/examples (extensions, custom tools, SDK)",
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
  `- Always read pi .md files completely and follow links to related docs ${PI_DOCS_BLOCK_END}`,
  "",
  "Current working directory: /home/llmx/amedac/piweb-data/sandbox-homes/u1/deadbeef",
].join("\n");

test("strips the SDK Pi-documentation block and tidies the seam", () => {
  const out = stripPiDocumentationBlock(BASE);
  assert.ok(!out.includes(PI_DOCS_BLOCK_START));
  assert.ok(!out.includes(PI_DOCS_BLOCK_END));
  assert.match(out, /Be concise in your responses/);
  // 文档块之后的内容（此处是 cwd 行）保留，交给下一个裁剪步骤。
  assert.match(out, /Current working directory:/);
  assert.ok(!/\n{3,}/.test(out), "no triple newlines left behind");
});

test("removes the Current working directory line (server path leak)", () => {
  const out = stripWorkingDirectoryLine(BASE);
  assert.ok(!out.includes("Current working directory"));
  assert.ok(!out.includes("/home/llmx/amedac"));
  assert.match(out, /Be concise in your responses/);
});

test("both strips compose and are safe when anchors are absent", () => {
  const out = stripWorkingDirectoryLine(stripPiDocumentationBlock(BASE));
  assert.ok(!out.includes("Pi documentation"));
  assert.ok(!out.includes("Current working directory"));
  // 幂等：二次裁剪不再变化。
  assert.equal(stripWorkingDirectoryLine(stripPiDocumentationBlock(out)), out);
  // 无锚点时原样返回（不猜、不误删）。
  const plain = "Custom prompt without the SDK blocks.\n\nCurrent working directory: /srv/app";
  assert.ok(stripPiDocumentationBlock(plain).startsWith("Custom prompt"));
  assert.equal(stripWorkingDirectoryLine(plain), "Custom prompt without the SDK blocks.");
});
