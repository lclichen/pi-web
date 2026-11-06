import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");

test("the plugin sidebar groups project, user and global packages", () => {
  assert.match(source, /\(\["project", "user", "global"\] as PluginScope\[\]\)/);
  assert.match(source, /packages\.filter\(\(pkg\) => pkg\.scope === scope\)/);
});

test("scope tags style the user scope distinctly", () => {
  assert.match(source, /scope === "user"[\s\S]*?rgba\(16,185,129,0\.12\)/);
});
