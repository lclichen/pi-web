import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("uses the server-resolved current worktree identity", () => {
  assert.match(source, /currentWorktreePath: string \| null/);
  // This fork keys worktree identity off the server-resolved path instead of
  // upstream's inline projectRoot assignment in the sync effect.
  assert.match(
    source,
    /const isCurrent = wt\.path === currentWorktreePath/,
  );
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});
