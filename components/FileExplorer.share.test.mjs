import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("share dialog copies through copyText and only reports success after it resolves", () => {
  assert.match(source, /import \{ copyText \} from "@\/lib\/clipboard"/);
  // 非安全上下文（HTTP）没有 navigator.clipboard；直接调用会让 UI 假报已复制。
  assert.doesNotMatch(source, /navigator\.clipboard/);

  const shareFile = source.slice(source.indexOf("const shareFile"), source.indexOf("const copyShareUrl"));
  assert.match(shareFile, /await copyText\(data\.url\)/);
  assert.match(shareFile, /setShareCopied\(true\)/);
  assert.match(shareFile, /catch \{[\s\S]*?setShareCopied\(false\)/);

  const copyShareUrl = source.slice(source.indexOf("const copyShareUrl"), source.indexOf("const handleRename"));
  assert.match(copyShareUrl, /await copyText\(shareState\.url\)/);
  assert.match(copyShareUrl, /catch \{[\s\S]*?setShareCopied\(false\)/);
});
