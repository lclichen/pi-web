import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "package-mirror-env-"));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { updateServerSettings } = await jiti.import("./server-settings.ts");
const { packageMirrorExportScript } = await jiti.import("./package-mirror-env.ts");

test("remote terminal export script carries npm and pip mirrors", () => {
  updateServerSettings({
    npmRegistry: "https://registry.npmmirror.com",
    pipIndexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple",
  });
  const script = packageMirrorExportScript();
  assert.match(script, /export NPM_CONFIG_REGISTRY='https:\/\/registry\.npmmirror\.com'/);
  assert.match(script, /export npm_config_registry='https:\/\/registry\.npmmirror\.com'/);
  assert.match(script, /export PIP_INDEX_URL='https:\/\/pypi\.tuna\.tsinghua\.edu\.cn\/simple'/);

  updateServerSettings({ npmRegistry: "", pipIndexUrl: "" });
  assert.equal(packageMirrorExportScript(), "");
});
