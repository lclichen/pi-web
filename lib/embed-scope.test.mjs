import assert from "node:assert/strict";
import test from "node:test";

const { filterSessionsForEmbedScope, sessionMatchesEmbedScope } = await import("./embed-scope.ts");

const sessions = [
  { id: "p1-a", cwd: "/home/a", projectId: "p1", mode: "sandbox" },
  { id: "p1-b", cwd: "/home/b", projectId: "p1", mode: "local-machine" },
  { id: "p2-a", cwd: "/home/c", projectId: "p2", mode: "sandbox" },
  { id: "host-a", cwd: "/srv/workspace", mode: "host" },
  { id: "sub", cwd: "/home/b", projectId: "p1", mode: "local-machine", relation: { kind: "subagent" } },
];

test("project access tokens see every top-level session in that project", () => {
  const scope = { kind: "project", projectId: "p1", cwd: "/home/a" };
  assert.deepEqual(
    filterSessionsForEmbedScope(sessions, scope).map((session) => session.id),
    ["p1-a", "p1-b"],
  );
  assert.equal(sessionMatchesEmbedScope(scope, sessions[2]), false);
  assert.equal(sessionMatchesEmbedScope(scope, sessions[3]), false);
});

test("subagent sessions never leak into embed lists", () => {
  const scope = { kind: "project", projectId: "p1", cwd: "/home/a" };
  assert.equal(sessionMatchesEmbedScope(scope, sessions[4]), false);
});
