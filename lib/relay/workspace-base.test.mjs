import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * Local-machine workspace mapping (lib/relay/workspace-base.ts):
 * project.workdir must reach the agent either as a per-request `base`
 * (agent >= 0.2.0) or as a root-relative prefix (legacy agents). These tests
 * pin the path arithmetic and the legacy/outside-root error path.
 */

async function api() {
  return jiti.import("./workspace-base.ts");
}

test("relativeToRoot handles nested, equal and escaping paths", async () => {
  const { relativeToRoot } = await api();
  assert.equal(relativeToRoot("/home/me", "/home/me/proj/demo"), "proj/demo");
  assert.equal(relativeToRoot("/home/me", "/home/me"), "");
  assert.equal(relativeToRoot("/home/me", "/home/me2/demo"), null);
  assert.equal(relativeToRoot("/home/me", "/srv/demo"), null);
});

test("relativeToRoot compares Windows paths case-insensitively", async () => {
  const { relativeToRoot, isPathWithin } = await api();
  assert.equal(relativeToRoot("D:\\Work\\Repo", "d:/work/repo/src"), "src");
  assert.ok(isPathWithin("C:/Users/Me/proj", "c:/users/me"));
  assert.equal(relativeToRoot("C:\\one", "D:\\two"), null);
});

test("new agent: workdir becomes the per-request base", async () => {
  const { resolveRelayWorkspaceScope, toRelayPath } = await api();
  const info = {
    hostname: "h", os: "linux", arch: "amd64", workspaceRoot: "/home/me",
    agentVersion: "0.2.0", features: ["workspace-base"],
  };
  const scope = resolveRelayWorkspaceScope("/home/me/projects/demo", info);
  assert.equal(scope.base, "/home/me/projects/demo");
  assert.equal(scope.error, undefined);
  assert.equal(toRelayPath("src/main.ts", scope, "/home/me/projects/demo"), "src/main.ts");
  // Absolute paths under the workspace are made relative to the base.
  assert.equal(toRelayPath("/home/me/projects/demo/src/main.ts", scope, "/home/me/projects/demo"), "src/main.ts");
  // "." stays the workspace root.
  assert.equal(toRelayPath(".", scope, "/home/me/projects/demo"), ".");
});

test("legacy agent: nested workdir becomes a root-relative prefix", async () => {
  const { resolveRelayWorkspaceScope, toRelayPath } = await api();
  const info = {
    hostname: "h", os: "linux", arch: "amd64", workspaceRoot: "/home/me",
    agentVersion: "0.1.2",
  };
  const scope = resolveRelayWorkspaceScope("/home/me/projects/demo", info);
  assert.equal(scope.prefix, "projects/demo");
  assert.equal(scope.base, undefined);
  assert.equal(toRelayPath("src/main.ts", scope, "/home/me/projects/demo"), "projects/demo/src/main.ts");
  assert.equal(toRelayPath("/home/me/projects/demo/src/main.ts", scope, "/home/me/projects/demo"), "projects/demo/src/main.ts");
  assert.equal(toRelayPath(".", scope, "/home/me/projects/demo"), "projects/demo");
});

test("legacy agent rejects a workspace outside its shared root", async () => {
  const { resolveRelayWorkspaceScope } = await api();
  const info = {
    hostname: "h", os: "linux", arch: "amd64", workspaceRoot: "/home/me",
    agentVersion: "0.1.2",
  };
  const scope = resolveRelayWorkspaceScope("/srv/elsewhere", info);
  assert.ok(scope.error?.includes("/srv/elsewhere"));
  assert.ok(scope.error?.includes("0.2.0"));
});

test("no workdir keeps the agent-wide root; offline agent reports an error", async () => {
  const { resolveRelayWorkspaceScope } = await api();
  assert.deepEqual(resolveRelayWorkspaceScope(undefined, null), {});
  assert.deepEqual(
    resolveRelayWorkspaceScope("", { hostname: "h", os: "linux", arch: "amd64", workspaceRoot: "/", agentVersion: "0.1.2" }),
    {},
  );
  assert.ok(resolveRelayWorkspaceScope("/srv/app", null).error);
});

test("toWorkspaceRelative maps absolute workspace paths back for the AGENTS.md mirror", async () => {
  const { toWorkspaceRelative } = await api();
  assert.equal(toWorkspaceRelative("/home/me/proj/AGENTS.md", "/home/me/proj"), "AGENTS.md");
  assert.equal(toWorkspaceRelative("AGENTS.md", "/home/me/proj"), "AGENTS.md");
  assert.equal(toWorkspaceRelative("/etc/passwd", "/home/me/proj"), null);
});
