import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { normalizeWorkspaceRoot, pathScopeForSession, writePathScope } = await jiti.import("./path-scope.ts");

test("workspace roots: slashes normalized, '/' means no fence", () => {
  assert.equal(normalizeWorkspaceRoot("/srv/app/"), "/srv/app");
  assert.equal(normalizeWorkspaceRoot("C:\\\\Users\\\\me\\\\proj\\\\"), "C:/Users/me/proj");
  assert.equal(normalizeWorkspaceRoot("/"), null);
  assert.equal(normalizeWorkspaceRoot("   "), null);
  assert.equal(normalizeWorkspaceRoot(undefined), null);
});

test("session mode → path scope", () => {
  assert.deepEqual(pathScopeForSession("sandbox", undefined), { mode: "sandbox", workspaceRoot: "/workspace" });
  assert.deepEqual(pathScopeForSession("ssh", { workdir: "/srv/app" }), { mode: "ssh", workspaceRoot: "/srv/app" });
  assert.deepEqual(pathScopeForSession("local-machine", { workdir: "C:/work" }), {
    mode: "local-machine",
    workspaceRoot: "C:/work",
  });
  assert.equal(pathScopeForSession("host", { workdir: "/ignored" }), null);
  assert.equal(pathScopeForSession("quick", undefined), null);
  // 没有 workdir 的远程项目不写标记（无围栏意义）。
  assert.equal(writePathScope(mkdtempSync(join(tmpdir(), "scope-")), { mode: "ssh", workspaceRoot: null }), false);
});

test("writePathScope writes the runtime marker and sanitizes the root", () => {
  const home = mkdtempSync(join(tmpdir(), "scope-"));
  try {
    assert.equal(writePathScope(home, { mode: "sandbox", workspaceRoot: "/workspace/" }), true);
    const target = join(home, ".pi", "path-policy.scope.json");
    assert.equal(existsSync(target), true);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(parsed, { version: 1, mode: "sandbox", workspaceRoot: "/workspace" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
