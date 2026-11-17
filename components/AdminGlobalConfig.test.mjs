import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AdminGlobalConfig.tsx", import.meta.url), "utf8");

test("the global config panel owns its vertical scroll area", () => {
  // .settings-dialog-main is overflow:hidden and this section has no split
  // view of its own; without a scroll container the lower cards are clipped.
  assert.match(source, /height: "100%"/);
  assert.match(source, /maxHeight: "100%"/);
  assert.match(source, /overflowY: "auto"/);
});

test("a saved server setting notifies already-mounted settings sections", () => {
  assert.match(source, /window\.dispatchEvent\(new Event\("pi-web:server-settings-changed"\)\)/);
  // Only after the PUT succeeded: a failed save must not make the plugin page
  // re-read a value that never changed.
  const save = source.slice(source.indexOf("const save ="), source.indexOf("const bundleDefault"));
  assert.ok(save.indexOf("if (!res.ok) throw") < save.indexOf("server-settings-changed"));
});
