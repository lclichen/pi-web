import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSandboxWorkspaceOperations } = await jiti.import(
  "../../pi-config/agent/extensions/amedac-core/src/sandbox/workspace-provider.ts",
);
const { PlatformError } = await jiti.import(
  "../../pi-config/agent/extensions/amedac-core/src/sandbox/client.ts",
);

test("sandbox manifest maps container paths back to workspace-relative paths", async () => {
  let calls = 0;
  const client = {
    async toolManifest(_containerId, roots) {
      calls += 1;
      assert.deepEqual(roots, ["/workspace/.pi/skills", "/workspace/.pi/attachments"]);
      return {
        entries: [
          { path: "/workspace/.pi/skills/demo/SKILL.md", size: 5, mtimeMs: 1_700_000_000_000 },
          { path: "/workspace/.pi/attachments/pic.bin", size: 3, mtimeMs: 1_700_000_001_000 },
        ],
        truncated: false,
      };
    },
  };
  const ws = createSandboxWorkspaceOperations({ getClient: () => client, getContainerId: async () => 7 });
  const result = await ws.manifest([".pi/skills", ".pi/attachments"]);
  assert.equal(calls, 1);
  assert.deepEqual(result.entries, [
    { path: ".pi/skills/demo/SKILL.md", size: 5, mtimeMs: 1_700_000_000_000 },
    { path: ".pi/attachments/pic.bin", size: 3, mtimeMs: 1_700_000_001_000 },
  ]);
  assert.equal(result.truncated, false);
});

test("sandbox manifest remembers a missing platform endpoint instead of retrying", async () => {
  let calls = 0;
  const client = {
    async toolManifest() {
      calls += 1;
      throw new PlatformError(404, "not_found", "no route");
    },
  };
  const ws = createSandboxWorkspaceOperations({ getClient: () => client, getContainerId: async () => 7 });
  await assert.rejects(() => ws.manifest([".pi/skills"]), (error) => error.code === "UNSUPPORTED");
  await assert.rejects(() => ws.manifest([".pi/skills"]), (error) => error.code === "UNSUPPORTED");
  assert.equal(calls, 1, "404 is cached for this provider instance");
});
