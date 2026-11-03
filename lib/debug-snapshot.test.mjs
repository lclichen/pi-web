import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildDebugSnapshot } = await jiti.import("./debug-snapshot.ts");

test("an idle server has a well-formed empty snapshot", () => {
  const snapshot = buildDebugSnapshot(null, 1_700_000_000_000);

  assert.equal(snapshot.now, 1_700_000_000_000);
  assert.ok(snapshot.uptimeMs >= 0);
  assert.deepEqual(snapshot.sessions, []);
  assert.deepEqual(snapshot.streams, []);
  assert.deepEqual(snapshot.startingCwds, []);
  assert.deepEqual(snapshot.totals, {
    wrappers: 0,
    alive: 0,
    running: 0,
    streams: 0,
    startingCwds: 0,
  });
  assert.equal(snapshot.selected, null);
});

test("the debug route is admin-only and never starts a session", async () => {
  const route = await readFile(new URL("../app/api/agent/debug/route.ts", import.meta.url), "utf8");

  assert.match(route, /requireUserIdentity\(req\)/);
  assert.match(route, /user\.role !== "admin"/);
  assert.match(route, /buildDebugSnapshot\(sessionId\)/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /startRpcSession|renewSessionLivenessLeases|new EventSource|\.send\(/);
});

test("the snapshot builder only reads registries", async () => {
  const source = await readFile(new URL("./debug-snapshot.ts", import.meta.url), "utf8");

  assert.match(source, /getRpcSessionDebugSnapshots\(\)/);
  assert.match(source, /listAgentEventStreams\(\)/);
  assert.match(source, /getRpcStartingSessionCwds\(\)/);
  assert.doesNotMatch(source, /startRpcSession|\.send\(|acquireSessionLivenessLease/);
});
