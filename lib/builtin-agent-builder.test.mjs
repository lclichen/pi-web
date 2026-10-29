import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 独立数据目录，避免污染 dev 的 data/
const dataRoot = mkdtempSync(join(tmpdir(), "builtin-builder-"));
process.env.PI_WEB_DATA_DIR = dataRoot;

const { ensureBuiltinBundles, isProtectedBundleName, listBundles, deleteBundle } =
  await import("./config-bundles-store.ts");
const { inspectBundleZip } = await import("./bundle-inspect.ts");
const { builtinAgentBuilderBytes, BUILTIN_AGENT_BUILDER_NAME } = await import("./builtin-agent-builder.ts");

test("seeds the builtin agent-builder bundle on first ensure", async () => {
  assert.equal(listBundles().length, 0);
  await ensureBuiltinBundles();
  const bundles = listBundles();
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].name, BUILTIN_AGENT_BUILDER_NAME);
  assert.equal(bundles[0].kind, "zip");
  assert.equal(bundles[0].version, "1.1.1");
  // 幂等：再次 ensure 不重复
  await ensureBuiltinBundles();
  assert.equal(listBundles().length, 1);
});

test("re-seeds when the recorded version is stale (bundled content upgrades)", async () => {
  const { saveBundle } = await import("./config-bundles-store.ts");
  // Simulate a deployment seeded with the pre-skills 1.0.0 bundle.
  const metaPath = join(dataRoot, "config-bundles", "meta.json");
  const meta = JSON.parse((await import("node:fs")).readFileSync(metaPath, "utf8"));
  meta[BUILTIN_AGENT_BUILDER_NAME].version = "1.0.0";
  (await import("node:fs")).writeFileSync(metaPath, JSON.stringify(meta));
  await ensureBuiltinBundles();
  assert.equal(listBundles()[0].version, "1.1.1", "stale builtin is re-seeded on version bump");
  assert.ok(typeof saveBundle === "function");
});

test("builtin bundle is protected from deletion", async () => {
  assert.equal(isProtectedBundleName("agent-builder"), true);
  assert.equal(isProtectedBundleName("other"), false);
  assert.equal(deleteBundle(BUILTIN_AGENT_BUILDER_NAME), false);
  assert.equal(existsSync(join(dataRoot, "config-bundles", "agent-builder.zip")), true);
});

test("builder bundle contents: agents.md + packaging skill + developer skills, no labs/", async () => {
  const inspection = await inspectBundleZip(await builtinAgentBuilderBytes());
  assert.equal(inspection.package?.name, "agent-builder");
  assert.deepEqual(inspection.dependencies, ["node>=20"]);
  const skillPaths = inspection.skills.map((s) => s.path).join("\n");
  for (const name of ["agent-packaging", "pi-extension-dev", "skill-creator", "subagent-creator"]) {
    assert.ok(skillPaths.includes(name), `bundled skill ${name} present`);
  }
  // 技能树完整：references/ 与 scripts/ 随技能一起分发。
  assert.ok(skillPaths.includes("pi-extension-dev/references/events.md"));
  assert.ok(skillPaths.includes("subagent-creator/examples/"));
  // agents.md 写入项目根（构建者系统提示的载体）
  assert.equal(inspection.agentsMdBytes !== null && inspection.agentsMdBytes > 0, true);
  // 目录纪律：不携带 labs/
  assert.equal(inspection.counts.labs, 0);
});

test("cleanup", () => {
  rmSync(dataRoot, { recursive: true, force: true });
});
