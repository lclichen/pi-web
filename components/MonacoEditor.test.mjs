import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./MonacoEditor.tsx", import.meta.url), "utf8");

test("MonacoEditor reconciles the value prop with a reused model", () => {
  assert.match(source, /const editorRef = useRef/);
  assert.match(source, /editor\.getValue\(\) === value/);
  assert.match(source, /editor\.setValue\(value\)/);
  assert.match(source, /\}, \[mounted, value\]\)/);
});
