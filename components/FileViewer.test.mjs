import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const useLightweightSource = lines\.length > SOURCE_HIGHLIGHT_MAX_LINES;/);

  const lightweightStart = source.indexOf(") : useLightweightSource ? (");
  assert.notEqual(lightweightStart, -1);

  // This fork renders the full source view with Monaco (see MonacoEditor) instead
  // of upstream's per-line SyntaxHighlighter, so the heavy branch anchor is the
  // Monaco mount rather than a highlighter component.
  const monacoStart = source.indexOf("<MonacoEditor", lightweightStart);
  assert.notEqual(monacoStart, -1);

  const lightweightSource = source.slice(lightweightStart, monacoStart);
  assert.match(lightweightSource, /className="file-source-view is-lightweight"/);
  assert.match(lightweightSource, /lines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);
});
