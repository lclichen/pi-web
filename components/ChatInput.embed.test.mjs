import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("filters built-in and registered commands through the product allowlist", () => {
  assert.match(source, /isEmbedCommandAllowed\(allowedCommandNames, command\.name\)/);
  assert.match(source, /onBlockedCommand\?\.\(slashName\)/);
  assert.match(source, /normalizeEmbedCommandName\(command\.name\) === target/);
});

test("dense embed mode collapses secondary controls and shrinks the composer", () => {
  assert.match(source, /const denseControls = isMobile \|\| \(embedded && embeddedDensity !== "comfortable"\)/);
  assert.match(source, /const denseEmbed = embedded && embeddedDensity !== "comfortable"/);
  assert.match(source, /maxHeight: denseEmbed \? \(miniEmbed \? 72 : 120\) : 200/);
  assert.match(source, /width: denseEmbed \? 40 : 56/);
  assert.match(source, /!embedded && !isStreaming && onToolPresetChange/);
  assert.match(source, /!embedded && onSoundToggle !== undefined/);
});
