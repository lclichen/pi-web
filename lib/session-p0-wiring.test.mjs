import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Batch 1 wiring guards: every creation/restore/fork/batch path must carry the
 * canonical session contract, and unsupported SSH/Host paths must fail closed.
 */

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), "utf8");

test("agent/new rejects standalone SSH and records a descriptor", async () => {
  const source = await read("app/api/agent/new/route.ts");
  assert.match(source, /effectiveMode === "ssh" && !projectForMode/);
  assert.match(source, /descriptorForProject\(project/);
  assert.match(source, /descriptorForNewSession\(/);
  assert.match(source, /recordSessionMeta\(realSessionId, \{[\s\S]*?descriptor/);
});

test("restore refuses to fall back to Host when a descriptor is missing", async () => {
  const source = await read("lib/session-restore-options.ts");
  assert.match(source, /if \(meta && !descriptor\)/);
  assert.match(source, /new SessionRestoreError/);
  assert.doesNotMatch(source, /const mode = meta\?\.mode \?\? "host"/);
  assert.match(source, /descriptorFromMeta\(meta\)/);
});

test("fork, fork_branch and clone copy the session contract", async () => {
  const source = await read("lib/rpc-manager.ts");
  const forkStart = source.indexOf('case "fork"');
  const branchStart = source.indexOf('case "fork_branch"');
  const cloneStart = source.indexOf('case "clone"');
  const afterFork = source.slice(forkStart, branchStart);
  const afterBranch = source.slice(branchStart, cloneStart);
  const afterClone = source.slice(cloneStart, source.indexOf('case "navigate_tree"'));
  assert.match(afterFork, /copySessionMeta\(sourceSessionId, newSessionId\)/);
  assert.match(afterBranch, /copySessionMeta\(this\.inner\.sessionId, newSessionId\)/);
  assert.match(afterClone, /copySessionMeta\(sourceSessionId, newSessionId\)/);
  assert.match(source, /restoreOptions: RpcSessionStartOptions = \{\}/);
  assert.match(source, /extensionFactories: inheritedExtensions/);
});

test("batch host is admin-only and batch sessions record metadata", async () => {
  const route = await read("app/api/batch/tasks/route.ts");
  assert.match(route, /mode === "host" && auth\.identity\.user\.role !== "admin"/);
  const runner = await read("lib/batch/task-runner.ts");
  assert.match(runner, /recordSessionMeta\(realSessionId/);
  assert.match(runner, /descriptorForNewSession\(/);
});
