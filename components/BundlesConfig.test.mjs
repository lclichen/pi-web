import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bundlesSource = await readFile(new URL("./BundlesConfig.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/bundles/[name]/inspect/route.ts", import.meta.url), "utf8");

test("settings labels the section as Agents management with an Agent-definitions subtab", () => {
  assert.match(panelSource, /t\("bundles\.agentsAdmin"\)/);
  assert.doesNotMatch(panelSource, /t\("bundles\.configBundles"\), requiresProject: false, group: "admin"/);
  assert.match(bundlesSource, /bundle-subtabs/);
  assert.match(bundlesSource, /t\("bundles\.agentDefinitions"\)/);
});

test("agent definition detail inspects contents, dependencies, and previews files", () => {
  assert.match(bundlesSource, /\/api\/bundles\/\$\{encodeURIComponent\(bundleName\)\}\/inspect/);
  for (const key of [
    "detailContents", "detailDependencies", "detailManifest", "detailPreview",
    "sectionExtensions", "sectionSkills", "sectionAgents", "sectionModels",
    "sectionMcp", "sectionLabs", "binaryPreview",
  ]) {
    assert.match(bundlesSource, new RegExp(`bundles\\.${key}`));
  }
  // 删除走样式确认框（与设置面板其它破坏性操作一致）。
  assert.doesNotMatch(bundlesSource, /window\.confirm/);
  assert.match(bundlesSource, /useConfirm\(\)/);
});

test("inspect route is admin-gated and decrypts apkg before parsing", () => {
  assert.match(routeSource, /requireAdminIdentity/);
  assert.match(routeSource, /openApkgViaTool/);
  assert.match(routeSource, /inspectBundleZip/);
  assert.match(routeSource, /readBundleFileFromZip/);
  // 展示专用：不触发 .apkg 许可消耗（无 checkApkgLicense 调用）。
  assert.doesNotMatch(routeSource, /checkApkgLicense/);
});

test("host-mode apply is fenced, admin-only, and refuses initialized directories", async () => {
  const hostRoute = await readFile(new URL("../app/api/host/apply-bundle/route.ts", import.meta.url), "utf8");
  assert.match(hostRoute, /requireUserIdentity/);
  assert.match(hostRoute, /getAllowedFileRootsForRequest/);
  assert.match(hostRoute, /isExistingFilePathAllowed/);
  // .pi 预检：Host 目录套用仅限未初始化目录（409）。
  assert.match(hostRoute, /existsSync\(join\(cwd, "\.pi"\)\)/);
  assert.match(hostRoute, /status: 409/);
  // UI：Host 目录组菜单有套用入口，对话框走 host 路由。
  const treeSource = await readFile(new URL("./ProjectSessionTree.tsx", import.meta.url), "utf8");
  const dialogSource = await readFile(new URL("./ApplyBundleDialog.tsx", import.meta.url), "utf8");
  assert.match(treeSource, /setApplyHostDir\(menu\.directory/);
  assert.match(dialogSource, /hostDir \? \/\/ api\/host\/apply-bundle|hostDir\s*\?\s*await fetch\("\/api\/host\/apply-bundle"/);
});
