import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("offline package mode short-circuits before any registry/git probe", () => {
  assert.match(source, /isNpmPackagesDisabled/);
  assert.match(source, /updates: \[\]/);
  assert.ok(
    source.indexOf("isNpmPackagesDisabled()") < source.indexOf("checkPluginUpdates("),
    "the offline guard must run before checkPluginUpdates",
  );
});
