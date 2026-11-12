import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
const {
  SESSION_IDENTITY_REGISTRY_KEY,
  registerSessionIdentity,
  readSessionIdentity,
  unregisterSessionIdentity,
} = await jiti.import("./session-identity.ts");

test("registers, reads and releases a session identity", (t) => {
  const release = registerSessionIdentity("session-a", { userId: 7, userName: "alice" });
  t.after(release);
  assert.deepEqual(readSessionIdentity("session-a"), { userId: 7, userName: "alice" });

  release();
  release(); // idempotent
  assert.equal(readSessionIdentity("session-a"), undefined);
});

test("exports the cross-process adapter contract", () => {
  const registry = globalThis[Symbol.for(SESSION_IDENTITY_REGISTRY_KEY)];
  assert.equal(registry?.version, 1);
  assert.equal(typeof registry?.set, "function");
  assert.equal(typeof registry?.get, "function");
  assert.equal(typeof registry?.delete, "function");

  registerSessionIdentity("session-b", { userId: 9, userName: "bob" });
  assert.deepEqual(registry.get("session-b"), { userId: 9, userName: "bob" });
  unregisterSessionIdentity("session-b");
  assert.equal(registry.get("session-b"), undefined);
});

test("returns copies so callers cannot mutate the registry entry", () => {
  registerSessionIdentity("session-c", { userId: 1, userName: "carol" });
  const first = readSessionIdentity("session-c");
  first.userName = "mallory";
  assert.equal(readSessionIdentity("session-c").userName, "carol");
  unregisterSessionIdentity("session-c");
});
