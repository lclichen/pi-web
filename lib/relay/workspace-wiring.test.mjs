import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Wiring guard for the local-machine workspace fix. The original bug was not
 * in path arithmetic but in the fact that project.workdir was never handed to
 * the relay tools / file panel / terminal at all, so projects silently ran in
 * the agent's startup directory. These source assertions keep every entry
 * point connected.
 */

const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), "utf8");

test("session creation and restore pass the project workdir + bound machine to relay tools", async () => {
  const created = await read("app/api/agent/new/route.ts");
  assert.match(created, /makeRelayToolsExtension\(user\.id, \{[\s\S]*?workspaceDir: project\.workdir[\s\S]*?machineId: project\.machineId/);
  assert.match(created, /requireCompatibleAgent\(user\.id, project\.machineId\)/);

  const restored = await read("lib/session-restore-options.ts");
  assert.match(restored, /makeRelayToolsExtension\(meta\?\.ownerId \?\? user\.id, \{[\s\S]*?workspaceDir: project\.workdir/);
  assert.match(restored, /makeRelayBgChannel\([\s\S]*?project\?\.workdir\)/);

  const children = await read("lib/subagent-bridge.ts");
  assert.match(children, /makeRelayToolsExtension\(info\.ownerId, \{[\s\S]*?workspaceDir: project\.workdir/);
});

test("relay-backed tools / files / terminal send the per-request base", async () => {
  const tools = await read("lib/extensions/relay-tools.ts");
  assert.match(tools, /resolveRelayWorkspaceScope/);
  assert.match(tools, /toRelayPath\(/);
  assert.match(tools, /base: scope\.base/);

  const files = await read("lib/remote-session.ts");
  assert.match(files, /localWirePath\(ctx, path, scope\)/);
  assert.match(files, /base: scope\.base/);

  const terminal = await read("lib/remote-terminal.ts");
  assert.match(terminal, /const scope = localScope\(ctx\)/);
  assert.match(terminal, /base: scope\.base/);
});

test("project create/update validate workdirs on the target backend", async () => {
  const created = await read("app/api/projects/route.ts");
  assert.match(created, /validateAgentDirectory\(identity\.session\.user\.id, machineId, workdir\)/);
  assert.match(created, /sshListDirectory\(/);

  const updated = await read("app/api/projects/[id]/route.ts");
  assert.match(updated, /validateAgentDirectory\(/);
});
