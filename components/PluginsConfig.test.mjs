import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");

test("the plugin page reloads after a server-settings change", () => {
  // The settings dialog keeps sections mounted while hidden, so toggling
  // offline mode in 全局配置 would otherwise leave packagesOffline stale.
  assert.match(source, /addEventListener\("pi-web:server-settings-changed", refresh\)/);
  assert.match(source, /removeEventListener\("pi-web:server-settings-changed", refresh\)/);
  assert.match(source, /void loadPlugins\(\)/);
});
