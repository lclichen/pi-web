import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isQuickWorkspaceDir } from "./quick-workspace.ts";

process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "quick-workspace-"));

test("quick workspace detection is confined to dataDir/quick-homes", () => {
  const dataDir = process.env.PI_WEB_DATA_DIR;
  assert.equal(isQuickWorkspaceDir(join(dataDir, "quick-homes", "u3", "q-default-abcd")), true);
  assert.equal(isQuickWorkspaceDir(join(dataDir, "quick-homes", "u3")), true);
  // The root itself / sibling trees / unrelated projects are not quick workspaces.
  assert.equal(isQuickWorkspaceDir(join(dataDir, "quick-homes")), false);
  assert.equal(isQuickWorkspaceDir(join(dataDir, "quick-homes-other", "u3")), false);
  assert.equal(isQuickWorkspaceDir(join(dataDir, "projects", "p")), false);
  assert.equal(isQuickWorkspaceDir(""), false);
});
