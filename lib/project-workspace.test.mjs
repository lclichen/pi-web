import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createProjectWorkspaceOperations } = await jiti.import("./project-workspace.ts");

function project(mode) {
  return {
    id: "p-test",
    name: "p",
    ownerId: 7,
    mode,
    createdAt: 1,
    pinnedSessions: [],
  };
}

test("local-machine projects require a compatible online relay agent", async () => {
  const result = await createProjectWorkspaceOperations(project("local-machine"), { id: 7, role: "user" }, "");
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.error, /未连接|不在线/);
});

test("sandbox projects require the platform URL and the caller's credential", async () => {
  const saved = process.env.PI_WEB_PLATFORM_URL;
  delete process.env.PI_WEB_PLATFORM_URL;
  try {
    const noUrl = await createProjectWorkspaceOperations(project("sandbox"), { id: 7, role: "user" }, "sk_test");
    assert.equal(noUrl.ok, false);
    assert.equal(noUrl.status, 400);
    assert.match(noUrl.error, /PI_WEB_PLATFORM_URL/);

    process.env.PI_WEB_PLATFORM_URL = "http://127.0.0.1:1";
    const noKey = await createProjectWorkspaceOperations(project("sandbox"), { id: 7, role: "user" }, "");
    assert.equal(noKey.ok, false);
    assert.equal(noKey.status, 401);
  } finally {
    if (saved === undefined) delete process.env.PI_WEB_PLATFORM_URL;
    else process.env.PI_WEB_PLATFORM_URL = saved;
  }
});
