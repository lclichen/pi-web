import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { sourceLabel } = await jiti.import("./SkillsConfig.tsx");

test("labels annotated user-scope skills as user", () => {
  assert.equal(sourceLabel({ sourceInfo: { scope: "user" } }), "user");
});

test("labels user-scope installs even when the loader reports a generic path source", () => {
  assert.equal(
    sourceLabel({
      sourceInfo: { source: "path", scope: "path" },
      install: { scope: "user", package: "owner/repo", source: "skills.sh", canCheckForUpdates: true },
    }),
    "user",
  );
});

test("keeps project/global/path labels for other scopes", () => {
  assert.equal(sourceLabel({ sourceInfo: { scope: "project" } }), "project");
  assert.equal(sourceLabel({ sourceInfo: { scope: "global" } }), "global");
  assert.equal(sourceLabel({ sourceInfo: { scope: "path" } }), "path");
  assert.equal(sourceLabel({ sourceInfo: {} }), "path");
});

test("renders a localized scope badge, not the raw scope key", () => {
  assert.match(source, /t\("skills\.scope\.user"\)/);
  assert.match(source, /is-user/);
});

test("deletes skills through the API with a confirmation dialog", () => {
  assert.match(source, /const \{ confirm, confirmDialog \} = useConfirm\(\)/);
  assert.match(source, /skills\.deleteConfirmTitle/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /params\.set\("cwd", cwd\)/);
});

test("clears a stale save error when selecting another skill", () => {
  assert.match(source, /setSelected\(skill\.filePath\);[\s\S]*?setSaveError\(null\);/);
});
