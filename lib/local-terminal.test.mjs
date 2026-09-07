import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("spawned shells default to a UTF-8 locale when the host has none", async () => {
  // Upstream 2e914db: Windows shells inherit the ANSI codepage (GBK on
  // zh-CN hosts) and mangle non-ASCII filenames unless LANG is defaulted.
  // Source-level assertion — createLocalTerminal loads the real node-pty,
  // so a behavioral test would need a full PTY.
  const source = readFileSync(new URL("./local-terminal.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!process\.env\.LANG && !process\.env\.LC_ALL && !process\.env\.LC_CTYPE\) env\.LANG = "C\.UTF-8"/);
});
