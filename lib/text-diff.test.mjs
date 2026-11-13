import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./text-diff.ts");
}

test("unifiedTextDiff shows added and removed lines with context", async () => {
  const { unifiedTextDiff } = await loadSubject();
  const before = ["a", "b", "c", "d", "e"].join("\n");
  const after = ["a", "b", "C", "d", "e", "f"].join("\n");
  const diff = unifiedTextDiff(before, after, ".pi/skills/x/SKILL.md");
  assert.match(diff, /^--- a\/\.pi\/skills\/x\/SKILL\.md/m);
  assert.match(diff, /^\+C$/m);
  assert.match(diff, /^-c$/m);
  assert.match(diff, /^\+f$/m);
  assert.match(diff, /@@ -1,5 \+1,6 @@/);
});

test("unifiedTextDiff returns empty for identical content", async () => {
  const { unifiedTextDiff } = await loadSubject();
  assert.equal(unifiedTextDiff("same\nlines", "same\nlines", "a.txt"), "");
});

test("unifiedTextDiff truncates oversized output", async () => {
  const { unifiedTextDiff } = await loadSubject();
  const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");
  const diff = unifiedTextDiff(before, after, "big.txt", { maxOutputChars: 200 });
  assert.match(diff, /diff truncated/);
  assert.ok(diff.length < 400);
});

test("isProbablyText distinguishes UTF-8 text from binary", async () => {
  const { isProbablyText } = await loadSubject();
  assert.equal(isProbablyText(Buffer.from("报告\nok", "utf8")), true);
  assert.equal(isProbablyText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff])), false);
  assert.equal(isProbablyText(Buffer.from([0x61, 0x00, 0x62])), false);
});
