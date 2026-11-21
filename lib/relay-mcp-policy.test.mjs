import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isRelayWorkspaceStdio, relayWorkspaceEntryProblem } = await jiti.import("./relay-mcp-policy.ts");

const safe = {
  command: "node",
  args: [".pi/mcp/cli.js"],
  lifecycle: "lazy",
  directTools: false,
  piWeb: { plane: "workspace" },
};

test("only project stdio with plane=workspace is relay-hosted", () => {
  assert.equal(isRelayWorkspaceStdio(safe), true);
  assert.equal(isRelayWorkspaceStdio({ ...safe, url: "https://x" }), false);
  assert.equal(isRelayWorkspaceStdio({ ...safe, piWeb: { plane: "host" } }), false);
  assert.equal(isRelayWorkspaceStdio({ ...safe, disabled: true }), false);
});

test("relay entries must be lazy and directTools=false", () => {
  assert.equal(relayWorkspaceEntryProblem(safe), null);
  assert.equal(relayWorkspaceEntryProblem({ ...safe, lifecycle: "lazy-keep-alive" }), null);
  assert.match(relayWorkspaceEntryProblem({ ...safe, lifecycle: "keep-alive" }), /lifecycle/);
  assert.match(relayWorkspaceEntryProblem({ ...safe, lifecycle: "eager" }), /lifecycle/);
  assert.match(relayWorkspaceEntryProblem({ ...safe, directTools: true }), /directTools/);
  assert.match(relayWorkspaceEntryProblem({ ...safe, directTools: undefined }), /directTools/);
  assert.equal(relayWorkspaceEntryProblem({ ...safe, piWeb: { plane: "host" } }), null);
});
