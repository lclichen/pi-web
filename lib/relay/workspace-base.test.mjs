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
    hostname: "h",
    os: "linux",
    arch: "amd64",
    workspaceRoot: "/home/me",
    agentVersion: "0.2.0",
    features: ["workspace-base"],
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
    hostname: "h",
    os: "linux",
    arch: "amd64",
    workspaceRoot: "/home/me",
    agentVersion: "0.1.2",
  };
  const scope = resolveRelayWorkspaceScope("/home/me/projects/demo", info);
  assert.equal(scope.prefix, "projects/demo");
  assert.equal(scope.base, undefined);
  assert.equal(toRelayPath("src/main.ts", scope, "/home/me/projects/demo"), "projects/demo/src/main.ts");
  assert.equal(
    toRelayPath("/home/me/projects/demo/src/main.ts", scope, "/home/me/projects/demo"),
    "projects/demo/src/main.ts",
  );
  assert.equal(toRelayPath(".", scope, "/home/me/projects/demo"), "projects/demo");
});

test("legacy agent rejects a workspace outside its shared root", async () => {
  const { resolveRelayWorkspaceScope } = await api();
  const info = {
    hostname: "h",
    os: "linux",
    arch: "amd64",
    workspaceRoot: "/home/me",
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
    resolveRelayWorkspaceScope("", {
      hostname: "h",
      os: "linux",
      arch: "amd64",
      workspaceRoot: "/",
      agentVersion: "0.1.2",
    }),
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

test("toRelayPath passes absolute paths verbatim in every mode (doubled-path fix)", async () => {
  const { toRelayPath } = await jiti.import("./workspace-base.ts");
  // prefix 模式（老 agent）下绝对路径原样传——此前 strip 前导斜杠会让
  // agent 端 join(root, "a/b/c") 产生 root+/a/b/c 的双拼路径。
  const prefixScope = { prefix: "proj" };
  assert.equal(toRelayPath("/abs/other/file.txt", prefixScope, "/work"), "/abs/other/file.txt");
  // base 模式同样原样。
  assert.equal(toRelayPath("/abs/x", { base: "/work" }, "/work"), "/abs/x");
  // 无 workdir 时也原样（此前会 strip）。
  assert.equal(toRelayPath("/abs/x", { prefix: "" }, undefined), "/abs/x");
  // workdir 内的绝对路径仍相对化（既有行为不变）。
  assert.equal(toRelayPath("/work/src/a.ts", { prefix: "" }, "/work"), "src/a.ts");
});

test("approved outside paths widen the relay root; legacy prefix agents stay fenced", async () => {
  const { toApprovedRelayPath } = await api();
  const scope = { base: "/home/me/proj" };
  const outside = toApprovedRelayPath("/tmp/mcp.py", scope, "/home/me/proj");
  assert.equal(outside.path, "/tmp/mcp.py");
  assert.equal(outside.scope.base, "/", "the agent must be rooted at a directory containing the target");
  assert.equal(scope.base, "/home/me/proj", "the session scope is not mutated");

  const inside = toApprovedRelayPath("/home/me/proj/src/a.ts", scope, "/home/me/proj");
  assert.deepEqual(inside, { path: "src/a.ts", scope });

  const legacy = toApprovedRelayPath("/tmp/mcp.py", { prefix: "proj" }, "/home/me/proj");
  assert.deepEqual(legacy, { path: "/tmp/mcp.py", scope: { prefix: "proj" } });

  // No project workdir: the agent's shared root applies, but a guard-approved
  // absolute target still needs an explicit containing base.
  const noWorkdir = toApprovedRelayPath("/tmp/mcp.py", {}, undefined);
  assert.deepEqual(noWorkdir, { path: "/tmp/mcp.py", scope: { base: "/" } });

  const windows = toApprovedRelayPath("D:\\work\\out.txt", { base: "C:/work" }, "C:/work");
  assert.equal(windows.path, "D:\\work\\out.txt");
  assert.equal(windows.scope.base, "D:/");
});

test("decodeUtf8Exact accepts text and rejects binary that would be mangled", async () => {
  const { decodeUtf8Exact } = await api();
  assert.equal(decodeUtf8Exact(Buffer.from("报告\nok", "utf8")), "报告\nok");
  assert.equal(decodeUtf8Exact(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff])), null);
});

test("projection-v1 feature gates the batched manifest", async () => {
  const { agentSupportsProjectionManifest } = await api();
  assert.equal(agentSupportsProjectionManifest(undefined), false);
  assert.equal(agentSupportsProjectionManifest({ features: ["binary-write"] }), false);
  assert.equal(agentSupportsProjectionManifest({ features: ["projection-v1"] }), true);
});
