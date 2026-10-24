import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * Path arithmetic for the local-machine directory picker
 * (lib/relay/browse.ts). The picker can climb anywhere the agent can reach,
 * so root/drive handling must be exact on both POSIX and Windows.
 */

async function api() {
  return jiti.import("./browse.ts");
}

test("normalizeDisplayPath keeps roots absolute", async () => {
  const { normalizeDisplayPath } = await api();
  assert.equal(normalizeDisplayPath("/home/me/"), "/home/me");
  assert.equal(normalizeDisplayPath("/"), "/");
  assert.equal(normalizeDisplayPath("C:\\"), "C:/");
  assert.equal(normalizeDisplayPath("C:\\work\\repo\\"), "C:/work/repo");
  assert.equal(normalizeDisplayPath("  "), "");
});

test("parentPathOf stops at POSIX and Windows roots", async () => {
  const { parentPathOf } = await api();
  assert.equal(parentPathOf("/home/me"), "/home");
  assert.equal(parentPathOf("/home"), "/");
  assert.equal(parentPathOf("/"), null);
  assert.equal(parentPathOf("C:/Users/me"), "C:/Users");
  assert.equal(parentPathOf("C:/Users"), "C:/");
  assert.equal(parentPathOf("C:/"), null);
});

test("joinDisplayPath does not produce double separators or drive-relative paths", async () => {
  const { joinDisplayPath } = await api();
  assert.equal(joinDisplayPath("/home/me", "proj"), "/home/me/proj");
  assert.equal(joinDisplayPath("/", "home"), "/home");
  assert.equal(joinDisplayPath("C:/", "Users"), "C:/Users");
  assert.equal(joinDisplayPath("C:/Work", "Repo"), "C:/Work/Repo");
});
