import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./EmbedTokenDialog.tsx", import.meta.url), "utf8");

test("creates a project-scoped token with the chosen product and TTL", () => {
  assert.match(source, /fetch\("\/api\/embed\/products"/);
  assert.match(source, /fetch\("\/api\/embed\/tokens"/);
  assert.match(source, /body: JSON\.stringify\(\{\s*projectId,/);
  assert.match(source, /ttlMinutes: ttlDays \* 24 \* 60/);
  assert.match(source, /productId,/);
});

test("shows the link once and only reports copied after a successful copy", () => {
  assert.match(source, /await copyText\(url\)/);
  assert.match(source, /setCopied\(true\)/);
  assert.match(source, /setCopied\(false\)/);
  assert.match(source, /t\("embed\.linkOnce"\)/);
  assert.match(source, /readOnly/);
});
