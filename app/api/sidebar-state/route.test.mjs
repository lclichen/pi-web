import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-sidebar-route-"));
const previousEnv = {
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
};
process.env.PI_WEB_DATA_DIR = join(root, "data");
process.env.PI_WEB_AUTH = "on";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("../../../lib/web-session.ts");
const { createProject, getProject, updateProject } = await jiti.import("../../../lib/projects.ts");
const { GET, PATCH } = await jiti.import("./route.ts");

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function sessionCookie() {
  const session = createWebSession(
    { id: 1, username: "admin", email: null, role: "admin", status: "active" },
    "sk_test",
    1,
  );
  return `${WEB_SESSION_COOKIE}=${session.sid}`;
}

function request(method, body) {
  return new Request("http://localhost/api/sidebar-state", {
    method,
    headers: {
      host: "localhost",
      cookie: sessionCookie(),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("pins platform projects and Host directories", async () => {
  const project = await createProject({ name: "pinned", ownerId: 1, mode: "local-machine" });
  assert.equal(project.ok, true);

  let response = await PATCH(request("PATCH", { projectKey: `project:${project.project.id}`, pinned: true }));
  assert.equal(response.status, 200);
  response = await PATCH(request("PATCH", { projectKey: "host:/srv/app", pinned: true }));
  assert.equal(response.status, 200);

  const body = await (await GET(request("GET"))).json();
  assert.deepEqual(body.pinnedProjects, ["host:/srv/app", `project:${project.project.id}`]);
});

test("pins and unpins sessions, clearing legacy project pins on unpin", async () => {
  const project = await createProject({ name: "legacy", ownerId: 1, mode: "local-machine" });
  assert.equal(project.ok, true);
  updateProject(project.project.id, { pinSessionId: "legacy-session" });

  let body = await (await GET(request("GET"))).json();
  assert.ok(body.pinnedSessions.includes("legacy-session"));

  let response = await PATCH(request("PATCH", { sessionId: "legacy-session", pinned: false }));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.pinnedSessions.includes("legacy-session"), false);
  assert.equal(getProject(project.project.id).pinnedSessions.includes("legacy-session"), false);

  response = await PATCH(request("PATCH", { sessionId: "new-session", pinned: true }));
  body = await response.json();
  assert.ok(body.pinnedSessions.includes("new-session"));
});

test("rejects malformed pin keys and bodies", async () => {
  let response = await PATCH(request("PATCH", { projectKey: "not-a-key", pinned: true }));
  assert.equal(response.status, 400);
  response = await PATCH(request("PATCH", { sessionId: "s", projectKey: "project:x", pinned: true }));
  assert.equal(response.status, 400);
  response = await PATCH(request("PATCH", { sessionId: "s", pinned: "yes" }));
  assert.equal(response.status, 400);
});
