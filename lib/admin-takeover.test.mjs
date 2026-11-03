import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { clearAdminTakeovers, hasAdminTakeover, isReadOnlyAgentCommand, setAdminTakeover } = await jiti.import(
  "./admin-takeover.ts",
);

const NUL = String.fromCharCode(0);

test("takeover is per (session, admin) and can be released", () => {
  setAdminTakeover("s1", 7, true);
  assert.equal(hasAdminTakeover("s1", 7), true);
  assert.equal(hasAdminTakeover("s1", 8), false, "不同管理员互不影响");
  assert.equal(hasAdminTakeover("s2", 7), false, "不同会话互不影响");
  setAdminTakeover("s1", 7, false);
  assert.equal(hasAdminTakeover("s1", 7), false);
});

test("expired takeover is rejected and cleaned; clear removes all admins of a session", () => {
  globalThis.__piAdminTakeovers ??= new Map();
  globalThis.__piAdminTakeovers.set(`s3${NUL}1`, Date.now() - 1);
  assert.equal(hasAdminTakeover("s3", 1), false);
  assert.equal(globalThis.__piAdminTakeovers.has(`s3${NUL}1`), false);

  setAdminTakeover("s4", 1, true);
  setAdminTakeover("s4", 2, true);
  clearAdminTakeovers("s4");
  assert.equal(hasAdminTakeover("s4", 1), false);
  assert.equal(hasAdminTakeover("s4", 2), false);
});

test("read-only command classification", () => {
  // import in a second statement keeps the earlier debug harness simple
  assert.equal(typeof isReadOnlyAgentCommand, "function");
  for (const type of ["get_state", "get_tools", "get_session_stats", "get_commands"]) {
    assert.equal(isReadOnlyAgentCommand(type), true, type);
  }
  for (const type of ["prompt", "steer", "abort", "set_model", "set_tools", "fork", "compact", "bash"]) {
    assert.equal(isReadOnlyAgentCommand(type), false, type);
  }
});
